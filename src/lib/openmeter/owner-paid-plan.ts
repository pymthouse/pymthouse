import type { OpenMeter } from "@openmeter/sdk";

import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
import { defaultRetailRateUsd } from "@/lib/plan-pricing";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { prepareOwnerCustomerStripeBilling } from "./billing-profiles";
import {
  DEFAULT_TRIAL_FEATURE_KEY,
  getHostedOpenMeterUrl,
  KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
  NETWORK_FEE_USD_MICROS_METER,
} from "./constants";
import { ensureOwnerCustomer, listOwnedPublicClientIds } from "./customers";
import {
  ensureKonnectTenantCatalog,
  findKonnectFeatureIdByKey,
} from "./konnect-catalog";
import { buildKonnectUsageRateCard } from "./konnect-plan-body";
import { changeKonnectSubscription } from "./konnect-subscriptions";
import {
  isOpenMeterConflictError,
  isOpenMeterPlanAlreadyPublishedError,
  isOpenMeterPlanNotFoundError,
} from "./plan-errors";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  listOpenMeterSubscriptionsForCustomer,
  verifyOpenMeterSubscriptionId,
} from "./subscription-read";
import { isOwnerStarterPlanKey } from "./owner-starter-key";
import {
  OWNER_PAID_PLAN_KEY,
  OWNER_PAID_PLAN_NAME,
  isOwnerPaidPlanKey,
} from "./owner-paid-key";
import { ownerHasChargeablePaymentMethod } from "./owner-payment-method";

export {
  OWNER_PAID_PLAN_KEY,
  OWNER_PAID_PLAN_NAME,
  isOwnerPaidPlanKey,
} from "./owner-paid-key";

export type OwnerPaidPlanRef = {
  key: string;
  openmeterPlanId: string;
  includedUsdMicros: string;
};

function parseIncludedMicros(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 5_000_000;
  }
  return Math.floor(n);
}

function buildOwnerPaidPlanBody(input: {
  planKey: string;
  featureId: string;
  includedUsdMicros: number;
  unitAmount: string;
}): Record<string, unknown> {
  return {
    key: input.planKey,
    name: OWNER_PAID_PLAN_NAME,
    currency: "USD",
    billing_cadence: "P1M",
    settlement_mode: KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
    phases: [
      {
        key: "default",
        name: "Default",
        rate_cards: [
          buildKonnectUsageRateCard({
            key: DEFAULT_TRIAL_FEATURE_KEY,
            name: "Network usage",
            featureId: input.featureId,
            unitAmount: input.unitAmount,
            includedUsdMicros: input.includedUsdMicros,
          }),
        ],
      },
    ],
    metadata: {
      pymthouse_plan_kind: "owner_paid",
      meter_slug: NETWORK_FEE_USD_MICROS_METER,
    },
  };
}

type FoundPlan = {
  id: string;
  key?: string;
  version?: number;
  status?: string;
};

async function findPlanByKey(
  client: OpenMeter,
  planKey: string,
): Promise<FoundPlan | null> {
  try {
    const listed = await client.plans.list({
      ...( { key: planKey } as Record<string, unknown> ),
      page: 1,
      pageSize: 50,
    } as Parameters<OpenMeter["plans"]["list"]>[0]);
    const items = (listed as { items?: Array<FoundPlan> })?.items ?? [];
    const exact = items.find((item) => item.key === planKey);
    if (exact?.id) {
      return exact;
    }
  } catch {
    // fall through to get-by-key
  }

  try {
    const plan = await client.plans.get(planKey);
    if (plan?.id) {
      return {
        id: plan.id,
        key: plan.key,
        version: typeof plan.version === "number" ? plan.version : undefined,
        status: plan.status,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function planNeedsPublish(status: string | undefined): boolean {
  return status === "draft" || status === "scheduled";
}

async function publishOwnerPaidPlanBestEffort(
  client: OpenMeter,
  planId: string,
): Promise<string> {
  try {
    const published = await client.plans.publish(planId);
    return published?.id ?? planId;
  } catch (err) {
    if (
      !isOpenMeterConflictError(err) &&
      !isOpenMeterPlanAlreadyPublishedError(err)
    ) {
      console.warn("openmeter: owner paid plan publish failed");
    }
    return planId;
  }
}

let ownerPaidPlanCache: ReturnType<
  typeof createAsyncTtlCache<OwnerPaidPlanRef>
> | null = null;

function getOwnerPaidPlanCache() {
  ownerPaidPlanCache ??= createAsyncTtlCache<OwnerPaidPlanRef>({
    ttlSeconds: resolveCacheTtlSeconds("OWNER_PAID_PLAN_CACHE_TTL_SECONDS", 600),
  });
  return ownerPaidPlanCache;
}

export function resetOwnerPaidPlanCacheForTests(): void {
  ownerPaidPlanCache = null;
}

export function invalidateOwnerPaidPlanCache(): void {
  ownerPaidPlanCache = null;
}

async function createOwnerPaidPlan(input: {
  client: OpenMeter;
  planKey: string;
  featureId: string;
  includedUsdMicros: string;
}): Promise<string> {
  const body = buildOwnerPaidPlanBody({
    planKey: input.planKey,
    featureId: input.featureId,
    includedUsdMicros: parseIncludedMicros(input.includedUsdMicros),
    unitAmount: defaultRetailRateUsd(),
  });

  try {
    const created = await input.client.plans.create(
      body as unknown as Parameters<OpenMeter["plans"]["create"]>[0],
    );
    if (!created?.id) {
      throw new Error("Failed to create Owner Paid plan");
    }
    return created.id;
  } catch (err) {
    if (!isOpenMeterConflictError(err)) {
      throw err;
    }
    const raced = await findPlanByKey(input.client, input.planKey);
    if (!raced?.id) {
      throw err;
    }
    return raced.id;
  }
}

/**
 * Ensure the platform Owner Paid plan exists (same meters as Sandbox Starter;
 * settlement collects via the owners Stripe billing profile).
 */
export async function ensureOwnerPaidPlanSynced(
  includedUsdMicros?: string,
): Promise<OwnerPaidPlanRef> {
  const amount = (
    includedUsdMicros ?? (await resolvePlatformOwnerStarterIncludedUsdMicros())
  ).trim();

  return getOwnerPaidPlanCache().get(`owner-paid-plan:${amount}`, async () =>
    ensureOwnerPaidPlanSyncedUncached({
      includedUsdMicros: amount,
      planKey: OWNER_PAID_PLAN_KEY,
    }),
  );
}

async function ensureOwnerPaidPlanSyncedUncached(input: {
  includedUsdMicros: string;
  planKey: string;
}): Promise<OwnerPaidPlanRef> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }

  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey);
  if (!useKonnect) {
    throw new Error("Owner Paid plan requires Konnect metering routes");
  }

  const client = getHostedAdminClient();
  await ensureKonnectTenantCatalog();
  const featureId = await findKonnectFeatureIdByKey(DEFAULT_TRIAL_FEATURE_KEY);
  if (!featureId) {
    throw new Error(`Konnect feature missing: ${DEFAULT_TRIAL_FEATURE_KEY}`);
  }

  const existing = await findPlanByKey(client, input.planKey);
  if (existing?.id) {
    if (planNeedsPublish(existing.status)) {
      await publishOwnerPaidPlanBestEffort(client, existing.id);
    }
    return {
      key: input.planKey,
      openmeterPlanId: existing.id,
      includedUsdMicros: input.includedUsdMicros,
    };
  }

  let openmeterPlanId = await createOwnerPaidPlan({
    client,
    planKey: input.planKey,
    featureId,
    includedUsdMicros: input.includedUsdMicros,
  });
  openmeterPlanId = await publishOwnerPaidPlanBestEffort(client, openmeterPlanId);

  return {
    key: input.planKey,
    openmeterPlanId,
    includedUsdMicros: input.includedUsdMicros,
  };
}

async function findActiveOwnerWalletSubscription(input: {
  client: OpenMeter;
  customerId: string;
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<{
  id: string;
  planKey: string;
  openmeterPlanId: string;
} | null> {
  if (input.hintOpenMeterSubscriptionId) {
    const verified = await verifyOpenMeterSubscriptionId(
      input.client,
      input.hintOpenMeterSubscriptionId,
    );
    if (verified?.id) {
      return {
        id: verified.id,
        planKey: verified.planKey ?? "",
        openmeterPlanId: verified.planId ?? "",
      };
    }
  }

  try {
    const listed = await listOpenMeterSubscriptionsForCustomer(
      input.client,
      input.customerId,
    );
    const active = listed.find(
      (s) =>
        s.status === "active" ||
        s.status === "trialing" ||
        s.status === "scheduled" ||
        s.status === "pending" ||
        !s.status,
    );
    if (!active?.id) {
      return null;
    }
    return {
      id: active.id,
      planKey: active.planKey ?? "",
      openmeterPlanId: active.planId ?? "",
    };
  } catch {
    return null;
  }
}

export class OwnerPaidUpgradeError extends Error {
  readonly code:
    | "payment_method_required"
    | "openmeter_unavailable"
    | "no_subscription"
    | "upgrade_failed";

  constructor(
    code: OwnerPaidUpgradeError["code"],
    message: string,
  ) {
    super(message);
    this.name = "OwnerPaidUpgradeError";
    this.code = code;
  }
}

/**
 * Upgrade an owner wallet from Sandbox Starter to Owner Paid.
 * Requires a chargeable default payment method; pins the owners Stripe
 * profile, then changes the Konnect subscription.
 */
export async function upgradeOwnerToPaidPlan(input: {
  ownerUserId: string;
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<{
  openmeterSubscriptionId: string;
  planKey: string;
  openmeterPlanId: string;
  alreadyPaid: boolean;
}> {
  if (!isHostedAdminClientAvailable()) {
    throw new OwnerPaidUpgradeError(
      "openmeter_unavailable",
      "OpenMeter is not configured",
    );
  }

  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new OwnerPaidUpgradeError(
      "upgrade_failed",
      "ownerUserId is required",
    );
  }

  const chargeable = await ownerHasChargeablePaymentMethod(ownerUserId);
  if (chargeable !== true) {
    throw new OwnerPaidUpgradeError(
      "payment_method_required",
      "Add a payment method before upgrading to Owner Paid",
    );
  }

  const plan = await ensureOwnerPaidPlanSynced();
  const client = getHostedAdminClient();
  const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
  const customer = await ensureOwnerCustomer(
    client,
    ownerUserId,
    publicClientIds,
  );

  // Ensure cus_… + owners Stripe profile before the Paid subscription change.
  await prepareOwnerCustomerStripeBilling({
    client,
    customerId: customer.id,
    customerKey: customer.key,
  });

  const existing = await findActiveOwnerWalletSubscription({
    client,
    customerId: customer.id,
    hintOpenMeterSubscriptionId: input.hintOpenMeterSubscriptionId,
  });

  if (!existing?.id) {
    throw new OwnerPaidUpgradeError(
      "no_subscription",
      "No active owner wallet subscription to upgrade",
    );
  }

  if (isOwnerPaidPlanKey(existing.planKey)) {
    return {
      openmeterSubscriptionId: existing.id,
      planKey: existing.planKey || plan.key,
      openmeterPlanId: existing.openmeterPlanId || plan.openmeterPlanId,
      alreadyPaid: true,
    };
  }

  if (
    existing.planKey &&
    !isOwnerStarterPlanKey(existing.planKey) &&
    !isOwnerPaidPlanKey(existing.planKey)
  ) {
    throw new OwnerPaidUpgradeError(
      "upgrade_failed",
      `Cannot upgrade subscription on plan ${existing.planKey} to Owner Paid`,
    );
  }

  try {
    await changeKonnectSubscription({
      subscriptionId: existing.id,
      customerId: customer.id,
      planId: plan.openmeterPlanId,
      timing: "immediate",
    });
  } catch (err) {
    if (isOpenMeterPlanNotFoundError(err)) {
      invalidateOwnerPaidPlanCache();
      const resynced = await ensureOwnerPaidPlanSynced();
      await changeKonnectSubscription({
        subscriptionId: existing.id,
        customerId: customer.id,
        planId: resynced.openmeterPlanId,
        timing: "immediate",
      });
      return {
        openmeterSubscriptionId: existing.id,
        planKey: resynced.key,
        openmeterPlanId: resynced.openmeterPlanId,
        alreadyPaid: false,
      };
    }
    throw new OwnerPaidUpgradeError(
      "upgrade_failed",
      err instanceof Error ? err.message : "Owner Paid upgrade failed",
    );
  }

  return {
    openmeterSubscriptionId: existing.id,
    planKey: plan.key,
    openmeterPlanId: plan.openmeterPlanId,
    alreadyPaid: false,
  };
}

/**
 * True when the owner wallet is on Owner Paid with a chargeable payment method
 * so mint/signer may continue past spendable=0 (overage invoices).
 */
export async function ownerWalletAllowsOverageInvoicing(
  ownerUserId: string,
): Promise<boolean> {
  const trimmed = ownerUserId.trim();
  if (!trimmed || !isHostedAdminClientAvailable()) {
    return false;
  }

  const chargeable = await ownerHasChargeablePaymentMethod(trimmed);
  if (chargeable !== true) {
    return false;
  }

  try {
    const client = getHostedAdminClient();
    const publicClientIds = await listOwnedPublicClientIds(trimmed);
    const customer = await ensureOwnerCustomer(
      client,
      trimmed,
      publicClientIds,
    );
    const existing = await findActiveOwnerWalletSubscription({
      client,
      customerId: customer.id,
    });
    return isOwnerPaidPlanKey(existing?.planKey);
  } catch {
    return false;
  }
}
