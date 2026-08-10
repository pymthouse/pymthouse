/**
 * Ownership check for prepaid top-up settlement: the `client_id` carried in the
 * Checkout session metadata must belong to the `owner_user_id` in the same
 * metadata, so a forged session cannot credit another owner's wallet.
 *
 * Lives outside the webhook route because a Next.js route module may only
 * export route fields (`POST`, `runtime`, …) — a test seam exported from
 * `route.ts` fails `next build`'s route type check.
 */
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { listOwnedPublicClientIds } from "@/lib/openmeter/customers";
import { getProviderApp } from "@/lib/provider-apps";

export type TopUpClientOwnedByOwner = (
  clientId: string,
  ownerUserId: string,
) => Promise<boolean>;

export type MerchantTopUpAccountMatches = (
  clientId: string,
  connectedAccountId: string,
) => Promise<boolean>;

export type ResolveAppBillingCurrency = (clientId: string) => Promise<string>;

let topUpClientOwnedByOwnerForTests: TopUpClientOwnedByOwner | null = null;
let merchantTopUpAccountMatchesForTests: MerchantTopUpAccountMatches | null =
  null;
let resolveAppBillingCurrencyForTests: ResolveAppBillingCurrency | null = null;

/**
 * Test-only override for top-up ownership checks (Stripe webhook route).
 * Always `null` (inert) outside NODE_ENV=test.
 */
export function __setTopUpClientOwnedByOwnerForTests(
  fn: TopUpClientOwnedByOwner | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setTopUpClientOwnedByOwnerForTests is only available in test");
  }
  topUpClientOwnedByOwnerForTests = fn;
}

/**
 * Test-only override for merchant Connect top-up account matching.
 * Always `null` (inert) outside NODE_ENV=test.
 */
export function __setMerchantTopUpAccountMatchesForTests(
  fn: MerchantTopUpAccountMatches | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__setMerchantTopUpAccountMatchesForTests is only available in test",
    );
  }
  merchantTopUpAccountMatchesForTests = fn;
}

/**
 * Test-only override for app billing currency resolution (auto top-up).
 * Always `null` (inert) outside NODE_ENV=test.
 */
export function __setResolveAppBillingCurrencyForTests(
  fn: ResolveAppBillingCurrency | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__setResolveAppBillingCurrencyForTests is only available in test",
    );
  }
  resolveAppBillingCurrencyForTests = fn;
}

/** Stripe / app currency codes compared case-insensitively. */
export function normalizeStripeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

/**
 * App settlement currency from `app_billing_config.default_currency`
 * (defaults to `usd`). Auto top-up create + webhook settle must agree.
 */
export async function resolveAppBillingCurrency(
  clientId: string,
): Promise<string> {
  if (resolveAppBillingCurrencyForTests) {
    return resolveAppBillingCurrencyForTests(clientId);
  }
  const app = await getProviderApp(clientId.trim());
  if (!app) {
    return "usd";
  }
  const config = await getAppBillingConfig(app.id);
  return normalizeStripeCurrency(config?.defaultCurrency) ?? "usd";
}

export async function topUpClientOwnedByOwner(
  clientId: string,
  ownerUserId: string,
): Promise<boolean> {
  if (topUpClientOwnedByOwnerForTests) {
    return topUpClientOwnedByOwnerForTests(clientId, ownerUserId);
  }
  const owned = await listOwnedPublicClientIds(ownerUserId);
  return owned.includes(clientId);
}

/**
 * Merchant Connect top-up: the event's `account` must match the app's
 * Connected Account id from `app_billing_config`.
 */
export async function merchantTopUpAccountMatches(
  clientId: string,
  connectedAccountId: string,
): Promise<boolean> {
  if (merchantTopUpAccountMatchesForTests) {
    return merchantTopUpAccountMatchesForTests(clientId, connectedAccountId);
  }
  const accountId = connectedAccountId.trim();
  if (!accountId) {
    return false;
  }
  const app = await getProviderApp(clientId.trim());
  if (!app) {
    return false;
  }
  const config = await getAppBillingConfig(app.id);
  return config?.stripeConnectedAccountId?.trim() === accountId;
}
