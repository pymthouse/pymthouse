/**
 * PymtHouse merchant Connect orchestration via Stripe Account Links.
 * OpenMeter Stripe app wiring remains a side effect for Starter until cutover.
 */
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import {
  appBillingConfig,
  appBillingOauthStates,
  appUserStripeCustomers,
} from "@/db/schema";
import {
  getAppBillingConfig,
  upsertAppBillingConfig,
  ensureAppStripeBillingReady,
} from "@/lib/openmeter/billing-profiles";
import {
  connectAccountLinkUrls,
  createAccountOnboardingLink,
  createConnectedCheckoutSession,
  createConnectedCustomer,
  createMerchantConnectedAccount,
  exchangeConnectOAuthCode,
  refreshConnectedAccountStatus,
  type StripeOnboardingMethod,
} from "@/lib/stripe/connect-accounts";

export type MerchantConnectMode = "account_link";

async function persistConnectedAccountFlags(input: {
  clientId: string;
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}): Promise<void> {
  const ready = input.chargesEnabled && input.detailsSubmitted;
  const existing = await getAppBillingConfig(input.clientId);
  // Do not write stripeConnectStatus here — that column is Plane A (OM Stripe
  // app install). Merchant readiness is stripeChargesEnabled + detailsSubmitted.
  await upsertAppBillingConfig(input.clientId, {
    stripeConnectedAccountId: input.accountId,
    stripeChargesEnabled: input.chargesEnabled,
    stripePayoutsEnabled: input.payoutsEnabled,
    stripeDetailsSubmitted: input.detailsSubmitted,
    connectedAt: ready
      ? (existing?.connectedAt ?? new Date().toISOString())
      : (existing?.connectedAt ?? null),
  });
}

async function syncConnectedAccountFlags(
  clientId: string,
  accountId: string,
): Promise<{
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}> {
  const status = await refreshConnectedAccountStatus(accountId);
  await persistConnectedAccountFlags({
    clientId,
    accountId,
    chargesEnabled: status.chargesEnabled,
    payoutsEnabled: status.payoutsEnabled,
    detailsSubmitted: status.detailsSubmitted,
  });
  return {
    chargesEnabled: status.chargesEnabled,
    payoutsEnabled: status.payoutsEnabled,
    detailsSubmitted: status.detailsSubmitted,
  };
}

/**
 * Apply Connect capability flags from a verified `account.updated` webhook.
 * No-ops (returns updated:false) when the acct_ is not linked to an app.
 */
export async function applyConnectedAccountWebhookUpdate(input: {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}): Promise<{ updated: boolean; clientId?: string }> {
  const rows = await db
    .select({ clientId: appBillingConfig.clientId })
    .from(appBillingConfig)
    .where(eq(appBillingConfig.stripeConnectedAccountId, input.accountId))
    .limit(1);
  const clientId = rows[0]?.clientId;
  if (!clientId) {
    return { updated: false };
  }
  await persistConnectedAccountFlags({
    clientId,
    accountId: input.accountId,
    chargesEnabled: input.chargesEnabled,
    payoutsEnabled: input.payoutsEnabled,
    detailsSubmitted: input.detailsSubmitted,
  });
  // Best-effort supplier sync — must not block Connect onboarding.
  try {
    const { syncTenantSupplierFromConnect } = await import(
      "@/lib/openmeter/supplier-sync"
    );
    await syncTenantSupplierFromConnect({
      clientId,
      accountId: input.accountId,
    });
  } catch (err) {
    console.warn(
      "supplier sync after account.updated failed",
      clientId,
      err instanceof Error ? err.message : String(err),
    );
  }
  return { updated: true, clientId };
}

/** Ensure OM Starter billing profile still exists (platform path). */
async function ensureOmStarterSideEffect(clientId: string): Promise<void> {
  try {
    await ensureAppStripeBillingReady({ clientId });
  } catch {
    // Non-fatal: merchant Connect can proceed without OM Stripe profile.
  }
}

export async function startMerchantConnect({
  clientId,
  email,
  displayName,
}: {
  clientId: string;
  /** Reserved for audit / future session binding; Account Links do not persist OAuth state. */
  userId: string;
  mode?: MerchantConnectMode;
  email?: string;
  displayName?: string;
}): Promise<{ method: "account_link"; url: string; accountId: string }> {
  await ensureOmStarterSideEffect(clientId);

  const existing = await getAppBillingConfig(clientId);
  let accountId = existing?.stripeConnectedAccountId?.trim() || "";
  if (!accountId) {
    accountId = await createMerchantConnectedAccount({
      clientId,
      email,
      displayName,
    });
    await upsertAppBillingConfig(clientId, {
      stripeConnectedAccountId: accountId,
      stripeOnboardingMethod: "account_link" satisfies StripeOnboardingMethod,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      stripeDetailsSubmitted: false,
    });
  }

  const urls = connectAccountLinkUrls(clientId);
  const linkUrl = await createAccountOnboardingLink({
    accountId,
    refreshUrl: urls.refreshUrl,
    returnUrl: urls.returnUrl,
  });
  await syncConnectedAccountFlags(clientId, accountId);
  return { method: "account_link", url: linkUrl, accountId };
}

export async function refreshMerchantAccountLink(clientId: string): Promise<{
  url: string;
  accountId: string;
}> {
  const config = await getAppBillingConfig(clientId);
  const accountId = config?.stripeConnectedAccountId?.trim();
  if (!config || !accountId) {
    throw new Error("No Connected Account yet — start onboarding first");
  }
  if (config.stripeOnboardingMethod === "oauth" && config.stripeChargesEnabled) {
    throw new Error("OAuth-linked accounts do not use Account Links");
  }
  const urls = connectAccountLinkUrls(clientId);
  const url = await createAccountOnboardingLink({
    accountId,
    refreshUrl: urls.refreshUrl,
    returnUrl: urls.returnUrl,
  });
  await syncConnectedAccountFlags(clientId, accountId);
  return { url, accountId };
}

export async function completeMerchantConnectOAuth(input: {
  clientId: string;
  state: string;
  code: string;
}): Promise<void> {
  const rows = await db
    .delete(appBillingOauthStates)
    .where(
      and(
        eq(appBillingOauthStates.state, input.state),
        eq(appBillingOauthStates.clientId, input.clientId),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("Invalid or expired OAuth state");
  }
  if (row.expiresAt < new Date().toISOString()) {
    throw new Error("OAuth state expired");
  }

  const accountId = await exchangeConnectOAuthCode(input.code);
  await upsertAppBillingConfig(input.clientId, {
    stripeConnectedAccountId: accountId,
    stripeOnboardingMethod: "oauth",
  });
  await syncConnectedAccountFlags(input.clientId, accountId);
  await ensureOmStarterSideEffect(input.clientId);
}

export async function syncMerchantConnectStatus(clientId: string): Promise<void> {
  const config = await getAppBillingConfig(clientId);
  const accountId = config?.stripeConnectedAccountId?.trim();
  if (!accountId) {
    return;
  }
  await syncConnectedAccountFlags(clientId, accountId);
}

export function isMerchantConnectPaymentsReady(
  config: typeof appBillingConfig.$inferSelect | null | undefined,
): boolean {
  return Boolean(
    config?.stripeConnectedAccountId?.trim() &&
      config.stripeChargesEnabled &&
      config.stripeDetailsSubmitted,
  );
}

export function connectPaymentsOnlyEnabled(
  config: typeof appBillingConfig.$inferSelect | null | undefined,
): boolean {
  if (process.env.STRIPE_CONNECT_PAYMENTS_ONLY?.trim() === "1") {
    return true;
  }
  return Boolean(config?.connectPaymentsOnly);
}

export async function upsertAppUserStripeCustomer(input: {
  clientId: string;
  externalUserId: string;
  stripeConnectedAccountId: string;
  stripeCustomerId: string;
  openmeterCustomerId?: string | null;
  openmeterCustomerKey?: string | null;
}): Promise<void> {
  const existing = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, input.clientId),
        eq(appUserStripeCustomers.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);
  const now = new Date().toISOString();
  if (existing[0]) {
    await db
      .update(appUserStripeCustomers)
      .set({
        stripeConnectedAccountId: input.stripeConnectedAccountId,
        stripeCustomerId: input.stripeCustomerId,
        openmeterCustomerId: input.openmeterCustomerId ?? null,
        openmeterCustomerKey: input.openmeterCustomerKey ?? null,
        updatedAt: now,
      })
      .where(eq(appUserStripeCustomers.id, existing[0].id));
    return;
  }
  await db.insert(appUserStripeCustomers).values({
    id: uuidv4(),
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: input.stripeConnectedAccountId,
    stripeCustomerId: input.stripeCustomerId,
    openmeterCustomerId: input.openmeterCustomerId ?? null,
    openmeterCustomerKey: input.openmeterCustomerKey ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function getAppUserStripeCustomer(input: {
  clientId: string;
  externalUserId: string;
}): Promise<typeof appUserStripeCustomers.$inferSelect | null> {
  const rows = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, input.clientId),
        eq(appUserStripeCustomers.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function ensureMerchantOwnedStripeCustomer(input: {
  clientId: string;
  externalUserId: string;
  accountId: string;
  name?: string;
  openmeterCustomerId?: string;
  openmeterCustomerKey?: string;
}): Promise<string> {
  const existing = await getAppUserStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  if (
    existing?.stripeCustomerId &&
    existing.stripeConnectedAccountId === input.accountId
  ) {
    return existing.stripeCustomerId;
  }
  const stripeCustomerId = await createConnectedCustomer({
    accountId: input.accountId,
    name: input.name ?? input.externalUserId,
    metadata: {
      pymthouse_client_id: input.clientId,
      external_user_id: input.externalUserId,
      ...(input.openmeterCustomerId
        ? { openmeter_customer_id: input.openmeterCustomerId }
        : {}),
      ...(input.openmeterCustomerKey
        ? { customer_key: input.openmeterCustomerKey }
        : {}),
    },
  });
  await upsertAppUserStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: input.accountId,
    stripeCustomerId,
    openmeterCustomerId: input.openmeterCustomerId,
    openmeterCustomerKey: input.openmeterCustomerKey,
  });
  return stripeCustomerId;
}

export async function createMerchantConnectCheckoutForUser(input: {
  clientId: string;
  externalUserId: string;
  successUrl: string;
  cancelUrl: string;
  openmeterCustomerId?: string;
  openmeterCustomerKey?: string;
}): Promise<{ checkoutUrl: string; sessionId: string }> {
  const config = await getAppBillingConfig(input.clientId);
  if (!isMerchantConnectPaymentsReady(config)) {
    throw new Error("Merchant Stripe Connect is not ready to accept payments");
  }
  const accountId = config!.stripeConnectedAccountId!;
  const customerId = await ensureMerchantOwnedStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    accountId,
    openmeterCustomerId: input.openmeterCustomerId,
    openmeterCustomerKey: input.openmeterCustomerKey,
  });
  const session = await createConnectedCheckoutSession({
    accountId,
    customerId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    mode: "setup",
    applicationFeeBps: config!.applicationFeeBps ?? 0,
    metadata: {
      pymthouse_client_id: input.clientId,
      external_user_id: input.externalUserId,
    },
  });
  return { checkoutUrl: session.url, sessionId: session.sessionId };
}
