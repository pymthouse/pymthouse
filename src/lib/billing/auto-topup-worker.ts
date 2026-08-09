/**
 * Opt-in per-user auto top-up: off-session Stripe charge → Konnect credit grant.
 *
 * Triggers:
 * - mint_reject: mint balance gate rejected
 * - lead_soft_negative: debt in soft-negative lead window (mint or live reauth)
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appUsers } from "@/db/schema";
import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import {
  effectiveAutoTopUpUsdMicros,
  effectiveSoftNegativeUsdMicros,
  isInAutoTopUpLeadWindow,
  type AutoTopUpReason,
} from "@/lib/billing/auto-topup-settings";
import { getUnbilledDebtUsdMicros } from "@/lib/billing/unbilled-debt";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import {
  ensureOwnerCustomer,
  findOpenMeterCustomerByKey,
  listOwnedPublicClientIds,
} from "@/lib/openmeter/customers";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import {
  getKonnectStripeBillingRefs,
  getStripeCustomerAppDataId,
} from "@/lib/openmeter/stripe-customer-data";
import { getSpendableUsdMicros } from "@/lib/openmeter/spendable-allowance";
import { getProviderApp } from "@/lib/provider-apps";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  autoTopUpGrantIdempotencyKey,
  createOffSessionAutoTopUpPaymentIntent,
} from "@/lib/stripe/auto-topup-charge";
import {
  getAppUserStripeCustomer,
  isMerchantConnectPaymentsReady,
} from "@/lib/stripe/merchant-connect";

const AUTO_TOP_UP_TTL_SECONDS = resolveCacheTtlSeconds(
  "AUTO_TOP_UP_COOLDOWN_SECONDS",
  60,
);

let attemptCache: ReturnType<typeof createAsyncTtlCache<boolean>> | null = null;

function getAttemptCache() {
  attemptCache ??= createAsyncTtlCache<boolean>({
    ttlSeconds: AUTO_TOP_UP_TTL_SECONDS,
    maxEntries: 2000,
  });
  return attemptCache;
}

export function __resetAutoTopUpCacheForTests(): void {
  attemptCache = null;
}

export type AppUserAutoTopUpPrefs = {
  enabled: boolean;
  amountUsdMicros: bigint;
  beforeSoftNegative: boolean;
};

/** Load per-user auto top-up prefs; missing row ⇒ disabled. */
export async function getAppUserAutoTopUpPrefs(input: {
  appId: string;
  externalUserId: string;
}): Promise<AppUserAutoTopUpPrefs> {
  const appId = input.appId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!appId || !externalUserId) {
    return {
      enabled: false,
      amountUsdMicros: effectiveAutoTopUpUsdMicros(null),
      beforeSoftNegative: true,
    };
  }
  const rows = await db
    .select({
      autoTopUpEnabled: appUsers.autoTopUpEnabled,
      autoTopUpUsdMicros: appUsers.autoTopUpUsdMicros,
      autoTopUpBeforeSoftNegative: appUsers.autoTopUpBeforeSoftNegative,
    })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, appId),
        eq(appUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return {
    enabled: Boolean(row?.autoTopUpEnabled),
    amountUsdMicros: effectiveAutoTopUpUsdMicros(row?.autoTopUpUsdMicros),
    beforeSoftNegative: row?.autoTopUpBeforeSoftNegative !== false,
  };
}

type StripeChargeTarget = {
  stripeCustomerId: string;
  paymentMethodId: string;
  stripeAccount: string | null;
  grantExternalUserId: string;
  grantClientId: string;
};

async function resolveStripeChargeTarget(input: {
  clientId: string;
  externalUserId: string;
}): Promise<StripeChargeTarget | null> {
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const app = await getProviderApp(input.clientId);
  const appId = app?.id?.trim() || identity.developerAppId;
  const billingConfig = await getAppBillingConfig(appId);
  const signal = AbortSignal.timeout(15_000);

  if (identity.isOwner && identity.ownerUserId) {
    if (!isHostedAdminClientAvailable()) return null;
    const client = getHostedAdminClient();
    const publicClientIds = await listOwnedPublicClientIds(identity.ownerUserId);
    const customer = await ensureOwnerCustomer(
      client,
      identity.ownerUserId,
      publicClientIds,
    );
    const konnect = await getKonnectStripeBillingRefs(customer.id, signal);
    const stripeCustomerId =
      konnect.stripeCustomerId ??
      (await getStripeCustomerAppDataId({ client, customerId: customer.id }));
    const paymentMethodId = konnect.defaultPaymentMethodId?.trim();
    if (!stripeCustomerId || !paymentMethodId) {
      return null;
    }
    return {
      stripeCustomerId,
      paymentMethodId,
      stripeAccount: null,
      grantExternalUserId: `owner:${identity.ownerUserId}`,
      grantClientId: identity.publicClientId,
    };
  }

  if (billingConfig?.billingMode === "merchant") {
    if (!isMerchantConnectPaymentsReady(billingConfig)) {
      return null;
    }
    const accountId = billingConfig.stripeConnectedAccountId?.trim();
    const merchantCustomer = await getAppUserStripeCustomer({
      clientId: appId,
      externalUserId: input.externalUserId.trim(),
    });
    if (
      !accountId ||
      !merchantCustomer?.stripeCustomerId?.trim() ||
      merchantCustomer.stripeConnectedAccountId !== accountId
    ) {
      return null;
    }
    // Merchant Connect: default PM is first attached when Konnect default is null.
    const { buildOwnerPaymentMethodList } = await import(
      "@/lib/openmeter/owner-payment-method"
    );
    const { items } = await buildOwnerPaymentMethodList({
      stripeCustomerId: merchantCustomer.stripeCustomerId,
      konnectDefaultPaymentMethodId: null,
      defaultFirstPaymentMethod: true,
      deps: {
        fetchImpl: fetch,
        signal,
        stripeAccount: accountId,
      },
    });
    const defaultPm = items.find((pm) => pm.isDefault) ?? items[0];
    if (!defaultPm?.id) {
      return null;
    }
    return {
      stripeCustomerId: merchantCustomer.stripeCustomerId,
      paymentMethodId: defaultPm.id,
      stripeAccount: accountId,
      grantExternalUserId: input.externalUserId.trim(),
      grantClientId: identity.publicClientId,
    };
  }

  // owner_rollup end-users bill the owner wallet — auto top-up is not
  // charged against the end-user card (no Connect customer). Soft-negative
  // still gates via the owner cost rail.
  if (billingConfig?.billingMode !== "merchant" && !identity.isOwner) {
    return null;
  }

  if (!isHostedAdminClientAvailable()) return null;
  const client = getHostedAdminClient();
  const publicClientId = await resolveOpenMeterMeterClientId(appId);
  const key = buildOpenMeterCustomerKey(publicClientId, input.externalUserId);
  const customer = await findOpenMeterCustomerByKey(client, key);
  const customerId = customer?.id?.trim();
  if (!customerId) return null;
  const konnect = await getKonnectStripeBillingRefs(customerId, signal);
  const stripeCustomerId =
    konnect.stripeCustomerId ??
    (await getStripeCustomerAppDataId({ client, customerId }));
  const paymentMethodId = konnect.defaultPaymentMethodId?.trim();
  if (!stripeCustomerId || !paymentMethodId) {
    return null;
  }
  return {
    stripeCustomerId,
    paymentMethodId,
    stripeAccount: null,
    grantExternalUserId: input.externalUserId.trim(),
    grantClientId: publicClientId,
  };
}

export async function maybeAutoTopUpForIdentity(input: {
  clientId: string;
  externalUserId: string;
  reason: AutoTopUpReason;
}): Promise<
  | "charged"
  | "skipped"
  | "rate_limited"
  | "unavailable"
  | "error"
  | "requires_action"
> {
  if (!isHostedAdminClientAvailable()) {
    return "unavailable";
  }
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return "skipped";
  }

  const rateKey = `${clientId}\u0000${externalUserId}`;
  const cache = getAttemptCache();
  const marker = { attempted: false };
  await cache.get(rateKey, async () => {
    marker.attempted = true;
    return true;
  });
  if (!marker.attempted) {
    return "rate_limited";
  }

  try {
    const identity = await resolveOpenMeterBillingIdentity({
      clientId,
      externalUserId,
    });
    const app = await getProviderApp(clientId);
    const appId = app?.id?.trim() || identity.developerAppId;

    // Prefs live on the end-user app_users row (merchant). Owner path: disabled
    // unless an app_users row exists for the bare owner id (rare).
    const prefsExternalUserId = identity.isOwner
      ? (identity.ownerUserId as string)
      : externalUserId.replace(/^owner:/, "");
    const prefs = await getAppUserAutoTopUpPrefs({
      appId,
      externalUserId: prefsExternalUserId,
    });
    if (!prefs.enabled) {
      return "skipped";
    }

    const spendableRaw = await getSpendableUsdMicros({
      clientId,
      externalUserId,
      identity,
    });
    const spendable = BigInt(spendableRaw ?? "0");
    if (spendable > 0n) {
      return "skipped";
    }

    const billingConfig = await getAppBillingConfig(appId);
    const softNegative = effectiveSoftNegativeUsdMicros(
      billingConfig?.softNegativeUsdMicros,
    );
    const debt = await getUnbilledDebtUsdMicros({
      clientId,
      externalUserId,
    });

    if (input.reason === "lead_soft_negative") {
      if (!prefs.beforeSoftNegative) {
        return "skipped";
      }
      if (
        !isInAutoTopUpLeadWindow({
          unbilledDebtUsdMicros: debt,
          softNegativeUsdMicros: softNegative,
          autoTopUpUsdMicros: prefs.amountUsdMicros,
        })
      ) {
        return "skipped";
      }
    }

    const target = await resolveStripeChargeTarget({
      clientId,
      externalUserId,
    });
    if (!target) {
      return "skipped";
    }

    const pi = await createOffSessionAutoTopUpPaymentIntent({
      stripeCustomerId: target.stripeCustomerId,
      paymentMethodId: target.paymentMethodId,
      amountUsdMicros: prefs.amountUsdMicros,
      clientId: target.grantClientId,
      externalUserId: target.grantExternalUserId,
      stripeAccount: target.stripeAccount,
    });

    if (!pi.ok) {
      if (pi.status && pi.status !== "succeeded") {
        return "requires_action";
      }
      console.warn(
        "[auto-topup] charge failed",
        sanitizeForLog(pi.error),
      );
      return "error";
    }

    await grantAllowanceUsdMicros({
      clientId: target.grantClientId,
      externalUserId: target.grantExternalUserId,
      amountUsdMicros: prefs.amountUsdMicros,
      source: "topup",
      idempotencyKey: autoTopUpGrantIdempotencyKey(pi.paymentIntentId),
    });
    return "charged";
  } catch (err) {
    console.warn(
      "[auto-topup] unexpected failure",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return "error";
  }
}

/** Fire-and-forget auto top-up (mint reject or lead window). */
export function scheduleAutoTopUp(input: {
  clientId: string;
  externalUserId: string;
  reason: AutoTopUpReason;
}): void {
  void maybeAutoTopUpForIdentity(input).catch((err) => {
    console.warn(
      "[auto-topup] schedule failed",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
  });
}
