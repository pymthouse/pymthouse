import type { OpenMeter } from "@openmeter/sdk";

import { createAsyncTtlCache, resolveCacheTtlSeconds } from "@/lib/async-ttl-cache";
import {
  ensureDefaultOwnerPaidTierRow,
  getOwnerSubscriptionTierByKey,
  listOwnerSubscriptionTiers,
  markOwnerSubscriptionTierSynced,
  parseOwnerTierMonthlyFeeUsd,
  requireSelectableOwnerSubscriptionTier,
  resolveOwnerTierOverageRateUsd,
  type OwnerSubscriptionTierRow,
} from "@/lib/billing/owner-subscription-tiers";
import {
  claimOwnerPaidUpgradeOperation,
  completeOwnerPaidUpgradeOperation,
  failOwnerPaidUpgradeOperation,
  type OwnerPaidUpgradeResult,
} from "@/lib/billing/owner-paid-upgrade-operations";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { prepareOwnerCustomerStripeBilling } from "./billing-profiles";
import { ensureOwnerCustomer, listOwnedPublicClientIds } from "./customers";
import { changeKonnectSubscription, restoreKonnectSubscription, unscheduleKonnectSubscriptionCancelation } from "./konnect-subscriptions";
import {
  findOpenMeterPlanByKey,
  forceSyncOwnerAllowancePlan,
  readFlatFeeUsdFromPlanBody,
  readUsageDiscountUsdMicrosFromPlanBody,
  type OwnerAllowancePlanRef,
} from "./owner-allowance-plan";
import { isOpenMeterPlanNotFoundError } from "./plan-errors";
import {
  listOpenMeterSubscriptionsForCustomer,
  verifyOpenMeterSubscriptionId,
  type OpenMeterSubscriptionView,
} from "./subscription-read";
import {
  clearScheduledSubscriptions,
  isKonnectScheduledChangeForbidden,
  isLiveSubscriptionStatus,
  isScheduledSubscriptionStatus,
  listScheduledSubscriptionIds,
  pickLiveSubscription,
} from "./subscription-state";
import { isOwnerStarterPlanKey } from "./owner-starter-key";
import {
  OWNER_PAID_PLAN_KEY,
  isOwnerPaidPlanKey,
} from "./owner-paid-key";
import { ownerHasChargeablePaymentMethod } from "./owner-payment-method";

export {
  OWNER_PAID_PLAN_KEY,
  OWNER_PAID_PLAN_NAME,
  isOwnerPaidPlanKey,
} from "./owner-paid-key";

export type OwnerPaidPlanRef = OwnerAllowancePlanRef & {
  monthlyFeeUsd?: string;
  tierId?: string;
};

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

function tierCacheKey(planKey: string): string {
  return `owner-paid-tier\u0000${planKey.trim()}`;
}

/** True when published OM plan fee + included match the Neon tier row. */
export function ownerPaidTierPlanMatchesPublished(input: {
  includedUsdMicros: string;
  monthlyFeeUsd: string;
  publishedIncluded: string | null;
  publishedFee: string | null;
}): boolean {
  const expectedFee = parseOwnerTierMonthlyFeeUsd(input.monthlyFeeUsd);
  return (
    input.publishedIncluded === input.includedUsdMicros &&
    expectedFee != null &&
    input.publishedFee === expectedFee
  );
}

/** Force-sync one Owner Paid tier (flat fee + usage) into OpenMeter. */
export async function forceSyncOwnerPaidTier(
  tier: OwnerSubscriptionTierRow,
): Promise<OwnerPaidPlanRef> {
  const monthlyFeeUsd = parseOwnerTierMonthlyFeeUsd(tier.monthlyFeeUsd);
  if (!monthlyFeeUsd) {
    throw new Error(`Tier ${tier.key} needs a positive monthlyFeeUsd`);
  }

  const synced = await forceSyncOwnerAllowancePlan({
    planKey: tier.key,
    planName: tier.name,
    planKind: "owner_paid_tier",
    includedUsdMicros: tier.includedUsdMicros,
    monthlyFeeUsd,
    unitAmount: resolveOwnerTierOverageRateUsd(tier.overageRateUsd),
    tierId: tier.id,
    warnLabel: `owner paid tier ${tier.key}`,
  });

  await markOwnerSubscriptionTierSynced({
    id: tier.id,
    openmeterPlanId: synced.openmeterPlanId,
  });

  invalidateOwnerPaidPlanCache();
  const ref: OwnerPaidPlanRef = {
    key: synced.key,
    openmeterPlanId: synced.openmeterPlanId,
    includedUsdMicros: synced.includedUsdMicros,
    monthlyFeeUsd,
    tierId: tier.id,
  };
  getOwnerPaidPlanCache().seed(tierCacheKey(tier.key), ref);
  return ref;
}

/**
 * @deprecated Prefer forceSyncOwnerPaidTier / forceSyncAllOwnerPaidTiers.
 * Kept for callers that still pass an included-micros override for the default key.
 */
export async function forceSyncOwnerPaidPlan(
  includedUsdMicros: string,
): Promise<OwnerPaidPlanRef> {
  await ensureDefaultOwnerPaidTierRow();
  const tier = await getOwnerSubscriptionTierByKey(OWNER_PAID_PLAN_KEY);
  if (!tier) {
    throw new Error("Default Owner Paid tier missing");
  }
  return forceSyncOwnerPaidTier({
    ...tier,
    includedUsdMicros: includedUsdMicros.trim() || tier.includedUsdMicros,
  });
}

/** Force-sync every active Owner Paid tier. Best-effort per tier. */
export async function forceSyncAllOwnerPaidTiers(): Promise<{
  synced: OwnerPaidPlanRef[];
  errors: Array<{ key: string; message: string }>;
}> {
  await ensureDefaultOwnerPaidTierRow();
  const tiers = await listOwnerSubscriptionTiers({ activeOnly: true });
  const synced: OwnerPaidPlanRef[] = [];
  const errors: Array<{ key: string; message: string }> = [];
  for (const tier of tiers) {
    try {
      synced.push(await forceSyncOwnerPaidTier(tier));
    } catch (err) {
      errors.push({
        key: tier.key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { synced, errors };
}

/**
 * Read-only peek at the default Owner Paid tier (admin platform GET).
 */
export async function peekOwnerPaidPlanPublished(): Promise<{
  planKey: string;
  openmeterPlanId: string | null;
  publishedIncludedUsdMicros: string | null;
  monthlyFeeUsd: string | null;
  tierCount: number;
}> {
  const tiers = await listOwnerSubscriptionTiers();
  const defaultTier = tiers.find((t) => t.key === OWNER_PAID_PLAN_KEY) ?? tiers[0];
  const planKey = defaultTier?.key ?? OWNER_PAID_PLAN_KEY;
  if (!isHostedAdminClientAvailable()) {
    return {
      planKey,
      openmeterPlanId: defaultTier?.openmeterPlanId ?? null,
      publishedIncludedUsdMicros: defaultTier?.includedUsdMicros ?? null,
      monthlyFeeUsd: defaultTier?.monthlyFeeUsd ?? null,
      tierCount: tiers.length,
    };
  }

  try {
    const client = getHostedAdminClient();
    const existing = await findOpenMeterPlanByKey(client, planKey);
    if (!existing?.id) {
      return {
        planKey,
        openmeterPlanId: null,
        publishedIncludedUsdMicros: null,
        monthlyFeeUsd: defaultTier?.monthlyFeeUsd ?? null,
        tierCount: tiers.length,
      };
    }
    const body = await client.plans.get(existing.id);
    return {
      planKey,
      openmeterPlanId: existing.id,
      publishedIncludedUsdMicros: readUsageDiscountUsdMicrosFromPlanBody(body),
      monthlyFeeUsd: defaultTier?.monthlyFeeUsd ?? null,
      tierCount: tiers.length,
    };
  } catch {
    return {
      planKey,
      openmeterPlanId: null,
      publishedIncludedUsdMicros: null,
      monthlyFeeUsd: defaultTier?.monthlyFeeUsd ?? null,
      tierCount: tiers.length,
    };
  }
}

/** Ensure a specific Owner Paid tier is synced to OpenMeter. */
export async function ensureOwnerPaidTierPlanSynced(
  planKey: string,
): Promise<OwnerPaidPlanRef> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }
  const key = planKey.trim() || OWNER_PAID_PLAN_KEY;
  return getOwnerPaidPlanCache().get(tierCacheKey(key), async () => {
    const tier = await requireSelectableOwnerSubscriptionTier(key);
    if (
      tier.openmeterPlanId &&
      isHostedAdminClientAvailable()
    ) {
      try {
        const client = getHostedAdminClient();
        const existing = await findOpenMeterPlanByKey(client, tier.key);
        if (existing?.id) {
          const body = await client.plans.get(existing.id);
          const publishedIncluded =
            readUsageDiscountUsdMicrosFromPlanBody(body);
          const publishedFee = readFlatFeeUsdFromPlanBody(body);
          if (
            ownerPaidTierPlanMatchesPublished({
              includedUsdMicros: tier.includedUsdMicros,
              monthlyFeeUsd: tier.monthlyFeeUsd,
              publishedIncluded,
              publishedFee,
            })
          ) {
            return {
              key: tier.key,
              openmeterPlanId: existing.id,
              includedUsdMicros: tier.includedUsdMicros,
              monthlyFeeUsd:
                parseOwnerTierMonthlyFeeUsd(tier.monthlyFeeUsd) ??
                tier.monthlyFeeUsd,
              tierId: tier.id,
            };
          }
        }
      } catch {
        // Fall through to force-sync.
      }
    }
    return forceSyncOwnerPaidTier(tier);
  });
}

/**
 * Ensure the default Owner Paid tier exists and is synced.
 * Prefer ensureOwnerPaidTierPlanSynced(planKey) for Upgrade.
 */
export async function ensureOwnerPaidPlanSynced(): Promise<OwnerPaidPlanRef> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }
  await ensureDefaultOwnerPaidTierRow();
  return ensureOwnerPaidTierPlanSynced(OWNER_PAID_PLAN_KEY);
}

/** Live wallet rows that can be plan-changed via Konnect `/change`. */
export function isLiveOwnerWalletSubscriptionStatus(
  status: string | null | undefined,
): boolean {
  return isLiveSubscriptionStatus(status);
}

/** Scheduled/pending successors — cannot be `/change`d (Konnect 403). */
export function isScheduledOwnerWalletSubscriptionStatus(
  status: string | null | undefined,
): boolean {
  return isScheduledSubscriptionStatus(status);
}

/**
 * Prefer a live (active/trialing) wallet subscription. Never return scheduled
 * rows for upgrade `/change` — those fail with
 * "transition cancel in state scheduled not allowed".
 * @internal Exported for unit tests.
 */
export function pickLiveOwnerWalletSubscription(
  listed: OpenMeterSubscriptionView[],
): OpenMeterSubscriptionView | null {
  return pickLiveSubscription(listed);
}

/** @internal Exported for unit tests. */
export function listScheduledOwnerWalletSubscriptionIds(
  listed: OpenMeterSubscriptionView[],
): string[] {
  return listScheduledSubscriptionIds(listed);
}

/** @internal Exported for unit tests. */
export { isKonnectScheduledChangeForbidden };

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
    if (
      verified?.id &&
      verified.customerId &&
      verified.customerId === input.customerId &&
      isLiveOwnerWalletSubscriptionStatus(verified.status)
    ) {
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
    const live = pickLiveOwnerWalletSubscription(listed);
    if (!live?.id) {
      return null;
    }
    return {
      id: live.id,
      planKey: live.planKey ?? "",
      openmeterPlanId: live.planId ?? "",
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
    | "confirm_required"
    | "tier_unavailable"
    | "upgrade_in_progress"
    | "upgrade_failed"
    | "subscription_conflict";

  constructor(
    code: OwnerPaidUpgradeError["code"],
    message: string,
  ) {
    super(message);
    this.name = "OwnerPaidUpgradeError";
    this.code = code;
  }
}

function selectLiveOwnerWalletSubscription(
  listed: OpenMeterSubscriptionView[],
  hintOpenMeterSubscriptionId?: string | null,
): OpenMeterSubscriptionView | null {
  const hinted = hintOpenMeterSubscriptionId
    ? listed.find(
        (s) =>
          s.id === hintOpenMeterSubscriptionId &&
          isLiveOwnerWalletSubscriptionStatus(s.status),
      )
    : null;
  const liveRaw = hinted ?? pickLiveOwnerWalletSubscription(listed);
  if (!liveRaw || isScheduledOwnerWalletSubscriptionStatus(liveRaw.status)) {
    return null;
  }
  return liveRaw;
}

function alreadyPaidUpgradeResult(input: {
  subscriptionId: string;
  planKey: string;
  openmeterPlanId: string;
  plan: OwnerPaidPlanRef;
  monthlyFeeUsd: string;
}): OwnerPaidUpgradeResult | null {
  if (isOwnerPaidPlanKey(input.planKey) && input.planKey === input.plan.key) {
    return {
      openmeterSubscriptionId: input.subscriptionId,
      planKey: input.planKey || input.plan.key,
      openmeterPlanId: input.openmeterPlanId || input.plan.openmeterPlanId,
      monthlyFeeUsd: input.monthlyFeeUsd,
      alreadyPaid: true,
    };
  }
  // planKey often missing on Konnect list/get — fall back to OpenMeter plan id.
  if (
    !input.planKey &&
    input.openmeterPlanId &&
    input.openmeterPlanId === input.plan.openmeterPlanId
  ) {
    return {
      openmeterSubscriptionId: input.subscriptionId,
      planKey: input.plan.key,
      openmeterPlanId: input.plan.openmeterPlanId,
      monthlyFeeUsd: input.monthlyFeeUsd,
      alreadyPaid: true,
    };
  }
  return null;
}

async function clearScheduledBeforePaidUpgrade(input: {
  client: OpenMeter;
  customerId: string;
  listed: OpenMeterSubscriptionView[];
  scheduledIds: string[];
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<{
  listed: OpenMeterSubscriptionView[];
  live: OpenMeterSubscriptionView | null;
  scheduledIds: string[];
}> {
  const canceledPaidForRestore = input.listed.find(
    (s) =>
      Boolean(s.id) &&
      (s.status || "").toLowerCase() === "canceled" &&
      isOwnerPaidPlanKey(s.planKey),
  );
  if (canceledPaidForRestore?.id) {
    try {
      await restoreKonnectSubscription({
        subscriptionId: canceledPaidForRestore.id,
      });
    } catch (restoreErr) {
      console.warn(
        "Owner Paid upgrade: restore canceled Paid failed",
        restoreErr instanceof Error ? restoreErr.message : restoreErr,
      );
      await clearScheduledOwnerSubscriptions(input.scheduledIds);
    }
  } else {
    await clearScheduledOwnerSubscriptions(input.scheduledIds);
  }

  const listed = await listOpenMeterSubscriptionsForCustomer(
    input.client,
    input.customerId,
  );
  const live = selectLiveOwnerWalletSubscription(
    listed,
    input.hintOpenMeterSubscriptionId,
  );
  const scheduledIds = listScheduledOwnerWalletSubscriptionIds(listed);
  if (!live && scheduledIds.length > 0) {
    throw new OwnerPaidUpgradeError(
      "subscription_conflict",
      "A scheduled plan change is blocking this upgrade and cannot be removed automatically. Contact support at billing@pymthouse.com.",
    );
  }
  return { listed, live, scheduledIds };
}

async function upgradeFromCanceledPaidSubscription(input: {
  ownerUserId: string;
  plan: OwnerPaidPlanRef;
  monthlyFeeUsd: string;
  canceledPaid: OpenMeterSubscriptionView;
  subscriptionId: string;
  customerId: string;
  client: OpenMeter;
}): Promise<OwnerPaidUpgradeResult> {
  try {
    await unscheduleKonnectSubscriptionCancelation({
      subscriptionId: input.subscriptionId,
    });
  } catch (err) {
    console.warn(
      "Owner Paid upgrade: unschedule canceled Paid failed",
      err instanceof Error ? err.message : err,
    );
    throw new OwnerPaidUpgradeError(
      "subscription_conflict",
      "Could not resume the canceled paid plan before upgrading. Contact support at billing@pymthouse.com.",
    );
  }

  const alreadyPaid = alreadyPaidUpgradeResult({
    subscriptionId: input.subscriptionId,
    planKey: input.canceledPaid.planKey ?? "",
    openmeterPlanId: input.canceledPaid.planId ?? "",
    plan: input.plan,
    monthlyFeeUsd: input.monthlyFeeUsd,
  });
  if (alreadyPaid) return alreadyPaid;

  return runClaimedOwnerPaidUpgrade({
    ownerUserId: input.ownerUserId,
    plan: input.plan,
    monthlyFeeUsd: input.monthlyFeeUsd,
    existingId: input.subscriptionId,
    existingPlanKey: input.canceledPaid.planKey ?? "",
    customerId: input.customerId,
    client: input.client,
    scheduledSubscriptionIds: [],
  });
}

/**
 * Upgrade an owner wallet from Sandbox Starter to a selected Owner Paid tier.
 * Requires confirm + chargeable PM; starts a new billing cycle immediately.
 * Durable owner+plan operation record guards Konnect writes and retries.
 */
export async function upgradeOwnerToPaidPlan(input: {
  ownerUserId: string;
  planKey?: string | null;
  confirm?: boolean;
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<OwnerPaidUpgradeResult> {
  assertUpgradeConfirm(input.confirm);
  assertHostedOpenMeterConfigured();

  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new OwnerPaidUpgradeError(
      "upgrade_failed",
      "ownerUserId is required",
    );
  }

  await assertChargeablePaymentMethod(ownerUserId);
  const { plan, monthlyFeeUsd } = await resolveUpgradePlan(input.planKey);

  const client = getHostedAdminClient();
  const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
  const customer = await ensureOwnerCustomer(
    client,
    ownerUserId,
    publicClientIds,
  );

  await prepareOwnerCustomerStripeBilling({
    client,
    customerId: customer.id,
    customerKey: customer.key,
  });

  let listed = await listOpenMeterSubscriptionsForCustomer(
    client,
    customer.id,
  );
  // Never treat scheduled/pending rows as change targets — Konnect 403s
  // "transition cancel in state scheduled not allowed".
  let live = selectLiveOwnerWalletSubscription(
    listed,
    input.hintOpenMeterSubscriptionId,
  );
  let scheduledIds = listScheduledOwnerWalletSubscriptionIds(listed);

  // Clear scheduled successors before claim (restore canceled Paid via metering/v1).
  if (!live && scheduledIds.length > 0) {
    const cleared = await clearScheduledBeforePaidUpgrade({
      client,
      customerId: customer.id,
      listed,
      scheduledIds,
      hintOpenMeterSubscriptionId: input.hintOpenMeterSubscriptionId,
    });
    listed = cleared.listed;
    live = cleared.live;
    scheduledIds = cleared.scheduledIds;
  }

  if (live?.id) {
    const existing = {
      id: live.id,
      planKey: live.planKey ?? "",
      openmeterPlanId: live.planId ?? "",
    };
    assertUpgradeableSubscription(existing);

    const alreadyPaid = alreadyPaidUpgradeResult({
      subscriptionId: existing.id,
      planKey: existing.planKey,
      openmeterPlanId: existing.openmeterPlanId,
      plan,
      monthlyFeeUsd,
    });
    if (alreadyPaid) return alreadyPaid;

    return runClaimedOwnerPaidUpgrade({
      ownerUserId,
      plan,
      monthlyFeeUsd,
      existingId: existing.id,
      existingPlanKey: existing.planKey,
      customerId: customer.id,
      client,
      scheduledSubscriptionIds: scheduledIds,
    });
  }

  // Cancel-at-period-end Paid (no scheduled successor — those were restored above).
  const canceledPaid = listed.find(
    (s) =>
      Boolean(s.id) &&
      (s.status || "").toLowerCase() === "canceled" &&
      isOwnerPaidPlanKey(s.planKey),
  );

  if (canceledPaid?.id) {
    return upgradeFromCanceledPaidSubscription({
      ownerUserId,
      plan,
      monthlyFeeUsd,
      canceledPaid,
      subscriptionId: canceledPaid.id,
      customerId: customer.id,
      client,
    });
  }

  // No live/canceled Paid — clear any stray scheduled rows and create Paid.
  return runClaimedOwnerPaidUpgrade({
    ownerUserId,
    plan,
    monthlyFeeUsd,
    existingId: null,
    existingPlanKey: "",
    customerId: customer.id,
    client,
    scheduledSubscriptionIds: scheduledIds,
  });
}

function assertUpgradeConfirm(confirm: boolean | undefined): void {
  if (confirm !== true) {
    throw new OwnerPaidUpgradeError(
      "confirm_required",
      "Confirm Upgrade to charge the monthly fee and start a new billing cycle",
    );
  }
}

function assertHostedOpenMeterConfigured(): void {
  if (!isHostedAdminClientAvailable()) {
    throw new OwnerPaidUpgradeError(
      "openmeter_unavailable",
      "OpenMeter is not configured",
    );
  }
}

async function assertChargeablePaymentMethod(ownerUserId: string): Promise<void> {
  const chargeable = await ownerHasChargeablePaymentMethod(ownerUserId);
  if (chargeable !== true) {
    throw new OwnerPaidUpgradeError(
      "payment_method_required",
      "Add a payment method before upgrading to Owner Paid",
    );
  }
}

async function resolveUpgradePlan(planKeyInput: string | null | undefined): Promise<{
  plan: OwnerPaidPlanRef;
  monthlyFeeUsd: string;
}> {
  const planKey = planKeyInput?.trim() || OWNER_PAID_PLAN_KEY;
  let plan: OwnerPaidPlanRef;
  try {
    plan = await ensureOwnerPaidTierPlanSynced(planKey);
  } catch (err) {
    throw new OwnerPaidUpgradeError(
      "tier_unavailable",
      err instanceof Error ? err.message : "Owner Paid tier is not available",
    );
  }

  const monthlyFeeUsd =
    plan.monthlyFeeUsd ||
    parseOwnerTierMonthlyFeeUsd(
      (await getOwnerSubscriptionTierByKey(plan.key))?.monthlyFeeUsd,
    ) ||
    "";
  if (!monthlyFeeUsd) {
    throw new OwnerPaidUpgradeError(
      "tier_unavailable",
      "Owner Paid tier has no monthly fee configured",
    );
  }
  return { plan, monthlyFeeUsd };
}

function assertUpgradeableSubscription(
  existing: {
    id?: string | null;
    planKey?: string | null;
    openmeterPlanId?: string | null;
  } | null,
): asserts existing is {
  id: string;
  planKey?: string | null;
  openmeterPlanId?: string | null;
} {
  if (!existing?.id) {
    throw new OwnerPaidUpgradeError(
      "no_subscription",
      "No active owner wallet subscription to upgrade",
    );
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
}

async function runClaimedOwnerPaidUpgrade(input: {
  ownerUserId: string;
  plan: OwnerPaidPlanRef;
  monthlyFeeUsd: string;
  existingId: string | null;
  existingPlanKey: string;
  customerId: string;
  client: OpenMeter;
  scheduledSubscriptionIds: string[];
}): Promise<OwnerPaidUpgradeResult> {
  const claim = await claimOwnerPaidUpgradeOperation({
    ownerUserId: input.ownerUserId,
    planKey: input.plan.key,
    // When there is no live subscription, force reclaim of any completed row
    // for this plan (prior Paid may be canceled with a leftover scheduled Starter).
    currentPlanKey: input.existingId
      ? input.existingPlanKey
      : "__no_live_subscription__",
  });
  if (claim.action === "return") {
    return claim.result;
  }
  if (claim.action === "reject") {
    throw new OwnerPaidUpgradeError(
      "upgrade_in_progress",
      "An Owner Paid upgrade for this plan is already in progress",
    );
  }

  const operationId = claim.operationId;
  let result: OwnerPaidUpgradeResult;
  try {
    result = await changeOrCreateSubscriptionToPaidTier({
      client: input.client,
      subscriptionId: input.existingId,
      customerId: input.customerId,
      plan: input.plan,
      monthlyFeeUsd: input.monthlyFeeUsd,
      scheduledSubscriptionIds: input.scheduledSubscriptionIds,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Owner Paid upgrade failed";
    try {
      await failOwnerPaidUpgradeOperation({ operationId, error: message });
    } catch (markErr) {
      console.error("Failed to mark Owner Paid upgrade operation failed", markErr);
    }
    if (err instanceof OwnerPaidUpgradeError) {
      throw err;
    }
    console.error("Owner Paid upgrade change failed", err);
    throw new OwnerPaidUpgradeError(
      "upgrade_failed",
      "Owner Paid upgrade failed",
    );
  }

  try {
    await completeOwnerPaidUpgradeOperation({ operationId, result });
  } catch (completeErr) {
    console.error(
      "Owner Paid upgrade completed in Konnect but operation row update failed",
      completeErr,
    );
  }
  return result;
}

async function clearScheduledOwnerSubscriptions(
  subscriptionIds: string[],
): Promise<void> {
  await clearScheduledSubscriptions(subscriptionIds);
}

async function assertNoRemainingScheduledSubscriptions(input: {
  client: OpenMeter;
  customerId: string;
  scheduledSubscriptionIds: string[];
}): Promise<void> {
  if (input.scheduledSubscriptionIds.length === 0) return;
  try {
    const remaining = listScheduledOwnerWalletSubscriptionIds(
      await listOpenMeterSubscriptionsForCustomer(
        input.client,
        input.customerId,
      ),
    );
    if (remaining.length > 0) {
      throw new OwnerPaidUpgradeError(
        "subscription_conflict",
        "A scheduled plan change is blocking this upgrade and cannot be removed automatically. Contact support at billing@pymthouse.com.",
      );
    }
  } catch (err) {
    if (err instanceof OwnerPaidUpgradeError) {
      throw err;
    }
    // Listing failed — still attempt create; conflict surfaces from Konnect.
  }
}

async function changeOrCreateSubscriptionToPaidTier(input: {
  client: OpenMeter;
  subscriptionId: string | null;
  customerId: string;
  plan: OwnerPaidPlanRef;
  monthlyFeeUsd: string;
  scheduledSubscriptionIds: string[];
}): Promise<OwnerPaidUpgradeResult> {
  const scheduledSet = new Set(input.scheduledSubscriptionIds);
  if (input.subscriptionId && scheduledSet.has(input.subscriptionId)) {
    throw new OwnerPaidUpgradeError(
      "subscription_conflict",
      "A scheduled plan change is blocking this upgrade and cannot be removed automatically. Contact support at billing@pymthouse.com.",
    );
  }

  if (input.subscriptionId) {
    try {
      return await changeSubscriptionToPaidTier({
        subscriptionId: input.subscriptionId,
        customerId: input.customerId,
        plan: input.plan,
        monthlyFeeUsd: input.monthlyFeeUsd,
      });
    } catch (err) {
      if (!isKonnectScheduledChangeForbidden(err)) {
        throw err;
      }
      console.warn(
        "Owner Paid upgrade: live change hit scheduled-state forbid; creating Paid subscription",
      );
    }
  }

  await clearScheduledOwnerSubscriptions(input.scheduledSubscriptionIds);
  await assertNoRemainingScheduledSubscriptions({
    client: input.client,
    customerId: input.customerId,
    scheduledSubscriptionIds: input.scheduledSubscriptionIds,
  });
  return createOwnerPaidSubscription({
    client: input.client,
    customerId: input.customerId,
    plan: input.plan,
    monthlyFeeUsd: input.monthlyFeeUsd,
  });
}

async function createOwnerPaidSubscription(input: {
  client: OpenMeter;
  customerId: string;
  plan: OwnerPaidPlanRef;
  monthlyFeeUsd: string;
}): Promise<OwnerPaidUpgradeResult> {
  let openmeterPlanId = input.plan.openmeterPlanId;
  let resultPlanKey = input.plan.key;
  let resultMonthlyFee = input.monthlyFeeUsd;

  let created;
  try {
    created = await input.client.subscriptions.create({
      customerId: input.customerId,
      plan: { key: resultPlanKey },
    });
  } catch (err) {
    if (!isOpenMeterPlanNotFoundError(err)) {
      throw err;
    }
    invalidateOwnerPaidPlanCache();
    const resynced = await ensureOwnerPaidTierPlanSynced(input.plan.key);
    openmeterPlanId = resynced.openmeterPlanId;
    resultPlanKey = resynced.key;
    resultMonthlyFee = resynced.monthlyFeeUsd || input.monthlyFeeUsd;
    created = await input.client.subscriptions.create({
      customerId: input.customerId,
      plan: { key: resultPlanKey },
    });
  }

  const createdId = created?.id?.trim();
  if (!createdId) {
    throw new OwnerPaidUpgradeError(
      "upgrade_failed",
      "Owner Paid subscription create returned no id",
    );
  }

  return {
    openmeterSubscriptionId: createdId,
    planKey: resultPlanKey,
    openmeterPlanId,
    monthlyFeeUsd: resultMonthlyFee,
    alreadyPaid: false,
  };
}

async function changeSubscriptionToPaidTier(input: {
  subscriptionId: string;
  customerId: string;
  plan: OwnerPaidPlanRef;
  monthlyFeeUsd: string;
}): Promise<OwnerPaidUpgradeResult> {
  let openmeterPlanId = input.plan.openmeterPlanId;
  let resultPlanKey = input.plan.key;
  let resultMonthlyFee = input.monthlyFeeUsd;
  let change;
  try {
    change = await changeKonnectSubscription({
      subscriptionId: input.subscriptionId,
      customerId: input.customerId,
      planId: openmeterPlanId,
      timing: "immediate",
    });
  } catch (err) {
    if (!isOpenMeterPlanNotFoundError(err)) {
      throw err;
    }
    invalidateOwnerPaidPlanCache();
    const resynced = await ensureOwnerPaidTierPlanSynced(input.plan.key);
    openmeterPlanId = resynced.openmeterPlanId;
    resultPlanKey = resynced.key;
    resultMonthlyFee = resynced.monthlyFeeUsd || input.monthlyFeeUsd;
    change = await changeKonnectSubscription({
      subscriptionId: input.subscriptionId,
      customerId: input.customerId,
      planId: openmeterPlanId,
      timing: "immediate",
    });
  }

  // Immediate change supersedes the prior subscription; persist the successor.
  const nextId =
    change.next?.id?.trim() ||
    change.current?.id?.trim() ||
    input.subscriptionId;

  return {
    openmeterSubscriptionId: nextId,
    planKey: resultPlanKey,
    openmeterPlanId,
    monthlyFeeUsd: resultMonthlyFee,
    alreadyPaid: false,
  };
}

/**
 * True when the owner wallet is on any Owner Paid tier with a chargeable
 * payment method so mint/signer may continue past spendable=0.
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
