import { eq, or } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerBillingConfig, users } from "@/db/schema";
import {
  resolvePlatformOwnerStarterDefault,
  setPlatformOwnerStarterIncludedUsdMicros,
} from "@/lib/billing/platform-owner-starter-default";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import {
  changeKonnectSubscription,
  listActiveKonnectSubscriptions,
  type KonnectSubscription,
} from "@/lib/openmeter/konnect-subscriptions";
import { isBaseOwnerStarterPlanKey } from "@/lib/openmeter/owner-starter-key";
import {
  forceSyncAllOwnerPaidTiers,
  OWNER_PAID_PLAN_KEY,
} from "@/lib/openmeter/owner-paid-plan";
import {
  ensureOwnerStarterSubscription,
  forceSyncOwnerStarterPlan,
  invalidateOwnerStarterPlanCache,
} from "@/lib/openmeter/owner-starter-plan";

export type BaseOwnerStarterMigrateStats = {
  updated: number;
  skipped: number;
  errors: number;
};

export type PlatformOwnerAllowanceWarning = {
  code: string;
  message: string;
};

/** Structured warning when Owner Paid force-sync fails after Starter succeeded. */
export function ownerPaidForceSyncWarning(err: unknown): PlatformOwnerAllowanceWarning {
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: "owner_paid_force_sync_failed",
    message:
      `Owner Paid plan was not force-synced (${message}). ` +
      "Starter is live; Paid will self-heal on the next upgrade.",
  };
}

export type RepublishPlatformOwnerAllowancePlansResult = {
  ownerStarterIncludedUsdMicros: string;
  ownerStarterPlanName: string;
  planKey: string;
  openmeterPlanId: string;
  ownerPaidPlanKey: string;
  ownerPaidOpenmeterPlanId: string | null;
  ownerPaidIncludedUsdMicros: string | null;
  /** Present only when `resyncSubscribers` was requested. */
  migrate: BaseOwnerStarterMigrateStats | null;
  resyncSubscribers: boolean;
  warnings: PlatformOwnerAllowanceWarning[];
};

/** Classify a Konnect subscription for base-key Owner Starter migration. */
export function classifyBaseOwnerStarterMigrateCandidate(input: {
  subscriptionPlanId: string;
  targetPlanId: string;
  planKey: string | null;
}): "skip_already_on_target" | "skip_not_base" | "migrate" {
  if (input.subscriptionPlanId === input.targetPlanId) {
    return "skip_already_on_target";
  }
  if (!isBaseOwnerStarterPlanKey(input.planKey)) {
    return "skip_not_base";
  }
  return "migrate";
}

/** True when an owner_billing_config starter override is a real micros amount. */
export function hasStarterAllowanceOverride(
  starterIncludedUsdMicros: string | null | undefined,
): boolean {
  const m = starterIncludedUsdMicros?.trim();
  return Boolean(m && /^\d+$/.test(m));
}

/**
 * Persist the new platform Developer wallet default and republish Owner
 * Starter (atomic). Owner Paid tiers are synced best-effort from their own
 * catalog rows (not from the Starter default).
 */
export async function republishPlatformOwnerAllowancePlans(input: {
  ownerStarterIncludedUsdMicros: string;
  ownerStarterPlanName?: string;
  updatedBy: string;
  resyncSubscribers?: boolean;
}): Promise<RepublishPlatformOwnerAllowancePlansResult> {
  const resyncSubscribers = input.resyncSubscribers === true;
  const warnings: PlatformOwnerAllowanceWarning[] = [];
  // Persist first so forceSync classifies the new amount as the base key, then
  // roll back if Starter OpenMeter sync fails so spendable allowance cannot
  // drift ahead of the published plan discount.
  const previous = await resolvePlatformOwnerStarterDefault();
  const settings = await setPlatformOwnerStarterIncludedUsdMicros({
    ownerStarterIncludedUsdMicros: input.ownerStarterIncludedUsdMicros,
    ownerStarterPlanName: input.ownerStarterPlanName,
    updatedBy: input.updatedBy,
  });
  invalidateOwnerStarterPlanCache();

  let plan;
  try {
    plan = await forceSyncOwnerStarterPlan(
      settings.ownerStarterIncludedUsdMicros,
    );
  } catch (err) {
    await setPlatformOwnerStarterIncludedUsdMicros({
      ownerStarterIncludedUsdMicros: previous.ownerStarterIncludedUsdMicros,
      ownerStarterPlanName: previous.ownerStarterPlanName,
      updatedBy: input.updatedBy,
    });
    invalidateOwnerStarterPlanCache();
    throw err;
  }

  let ownerPaidOpenmeterPlanId: string | null = null;
  let ownerPaidIncludedUsdMicros: string | null = null;
  let ownerPaidPlanKey: string = OWNER_PAID_PLAN_KEY;
  try {
    const paid = await forceSyncAllOwnerPaidTiers();
    for (const err of paid.errors) {
      warnings.push({
        code: "owner_paid_force_sync_failed",
        message: `Owner Paid tier ${err.key}: ${err.message}`,
      });
    }
    const defaultPaid =
      paid.synced.find((s) => s.key === OWNER_PAID_PLAN_KEY) ?? paid.synced[0];
    ownerPaidOpenmeterPlanId = defaultPaid?.openmeterPlanId ?? null;
    ownerPaidIncludedUsdMicros = defaultPaid?.includedUsdMicros ?? null;
    ownerPaidPlanKey = defaultPaid?.key ?? OWNER_PAID_PLAN_KEY;
  } catch (err) {
    console.warn("openmeter: Owner Paid tiers force-sync failed after platform default change");
    warnings.push(ownerPaidForceSyncWarning(err));
  }

  const migrate = resyncSubscribers
    ? await migrateBaseOwnerStarterSubscriptions({
        targetPlanId: plan.openmeterPlanId,
        targetPlanKey: plan.key,
      })
    : null;

  return {
    ownerStarterIncludedUsdMicros: settings.ownerStarterIncludedUsdMicros,
    ownerStarterPlanName: settings.ownerStarterPlanName,
    planKey: plan.key,
    openmeterPlanId: plan.openmeterPlanId,
    ownerPaidPlanKey,
    ownerPaidOpenmeterPlanId,
    ownerPaidIncludedUsdMicros,
    migrate,
    resyncSubscribers,
    warnings,
  };
}

function emptyStats(): BaseOwnerStarterMigrateStats {
  return { updated: 0, skipped: 0, errors: 0 };
}

async function migrateFromSubscriptionList(input: {
  targetPlanId: string;
}): Promise<{ stats: BaseOwnerStarterMigrateStats; eligible: number }> {
  const stats = emptyStats();
  let eligible = 0;
  const client = getHostedAdminClient();
  const active = await listActiveKonnectSubscriptions();

  for (const sub of active) {
    const result = await migrateOneListedSubscription(sub, input.targetPlanId, client);
    if (result === "eligible_updated") {
      eligible += 1;
      stats.updated += 1;
    } else if (result === "eligible_error") {
      eligible += 1;
      stats.errors += 1;
    } else if (result === "skipped") {
      stats.skipped += 1;
    } else if (result === "error") {
      stats.errors += 1;
    }
  }

  return { stats, eligible };
}

async function migrateOneListedSubscription(
  sub: KonnectSubscription,
  targetPlanId: string,
  client: ReturnType<typeof getHostedAdminClient>,
): Promise<"eligible_updated" | "eligible_error" | "skipped" | "error" | "ignore"> {
  const planId = sub.plan_id?.trim() || sub.planId?.trim() || "";
  if (!planId || !sub.id || !sub.customer_id) {
    return "ignore";
  }

  let planKey: string | null = null;
  try {
    const plan = await client.plans.get(planId);
    planKey = plan?.key?.trim() ?? null;
  } catch {
    return "error";
  }

  const action = classifyBaseOwnerStarterMigrateCandidate({
    subscriptionPlanId: planId,
    targetPlanId,
    planKey,
  });
  if (action === "skip_already_on_target") return "skipped";
  if (action === "skip_not_base") return "ignore";

  try {
    await changeKonnectSubscription({
      subscriptionId: sub.id,
      customerId: sub.customer_id,
      planId: targetPlanId,
      timing: "immediate",
    });
    return "eligible_updated";
  } catch {
    console.warn("openmeter: base owner starter migrate failed");
    return "eligible_error";
  }
}

async function migrateViaOwnerEnsure(input: {
  targetPlanId: string;
  targetPlanKey: string;
}): Promise<BaseOwnerStarterMigrateStats> {
  const stats = emptyStats();
  const ownerIds = await listOwnersOnPlatformDefaultStarter();
  for (const ownerUserId of ownerIds) {
    try {
      // Do not create wallet subscriptions as a side effect of an admin
      // platform-default change — only migrate owners who already have one.
      const ensured = await ensureOwnerStarterSubscription({
        ownerUserId,
        createIfMissing: false,
      });
      if (!ensured.openmeterSubscriptionId) {
        stats.skipped += 1;
        continue;
      }
      if (
        ensured.planKey === input.targetPlanKey &&
        ensured.openmeterPlanId === input.targetPlanId
      ) {
        stats.updated += 1;
      } else {
        stats.skipped += 1;
      }
    } catch {
      console.warn("openmeter: owner wallet base starter ensure failed");
      stats.errors += 1;
    }
  }
  return stats;
}

async function migrateBaseOwnerStarterSubscriptions(input: {
  targetPlanId: string;
  targetPlanKey: string;
}): Promise<BaseOwnerStarterMigrateStats> {
  if (!isHostedAdminClientAvailable()) {
    return emptyStats();
  }

  let listed: { stats: BaseOwnerStarterMigrateStats; eligible: number };
  try {
    listed = await migrateFromSubscriptionList({
      targetPlanId: input.targetPlanId,
    });
  } catch {
    console.warn(
      "openmeter: list active subscriptions for base owner starter migrate failed",
    );
    listed = { stats: emptyStats(), eligible: 0 };
  }

  // Konnect's global /subscriptions index often omits rows; fall back to
  // owners without a starter override (they should be on the base key).
  // Gate on eligibility only — per-subscription plans.get failures bump
  // stats.errors without marking eligibility and must not skip the fallback.
  if (listed.eligible === 0) {
    return migrateViaOwnerEnsure(input);
  }
  return listed.stats;
}

/** Developers/admins with no starter_included override (still on the shared base plan). */
export async function listOwnersOnPlatformDefaultStarter(): Promise<string[]> {
  const withOverride = await db
    .select({
      ownerUserId: ownerBillingConfig.ownerUserId,
      starterIncludedUsdMicros: ownerBillingConfig.starterIncludedUsdMicros,
    })
    .from(ownerBillingConfig);

  const overridden = new Set(
    withOverride
      .filter((r) => hasStarterAllowanceOverride(r.starterIncludedUsdMicros))
      .map((r) => r.ownerUserId),
  );

  const all = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.role, "developer"), eq(users.role, "admin")));

  return all.map((r) => r.id).filter((id) => !overridden.has(id));
}
