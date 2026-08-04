import { eq, or } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerBillingConfig, users } from "@/db/schema";
import { setPlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import {
  changeKonnectSubscription,
  listActiveKonnectSubscriptions,
  type KonnectSubscription,
} from "@/lib/openmeter/konnect-subscriptions";
import { isBaseOwnerStarterPlanKey } from "@/lib/openmeter/owner-starter-key";
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

export type RepublishBaseOwnerStarterResult = {
  ownerStarterIncludedUsdMicros: string;
  planKey: string;
  openmeterPlanId: string;
  /** Present only when `resyncSubscribers` was requested. */
  migrate: BaseOwnerStarterMigrateStats | null;
  resyncSubscribers: boolean;
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
 * Persist the new platform Owner Starter default and republish the shared base
 * plan. When `resyncSubscribers` is true, also migrate every active subscription
 * still on that base key (not amount-keyed override plans).
 */
export async function republishAndMigrateBaseOwnerStarter(input: {
  ownerStarterIncludedUsdMicros: string;
  updatedBy: string;
  resyncSubscribers?: boolean;
}): Promise<RepublishBaseOwnerStarterResult> {
  const resyncSubscribers = input.resyncSubscribers === true;
  const settings = await setPlatformOwnerStarterIncludedUsdMicros({
    ownerStarterIncludedUsdMicros: input.ownerStarterIncludedUsdMicros,
    updatedBy: input.updatedBy,
  });
  invalidateOwnerStarterPlanCache();

  const plan = await forceSyncOwnerStarterPlan(
    settings.ownerStarterIncludedUsdMicros,
  );

  const migrate = resyncSubscribers
    ? await migrateBaseOwnerStarterSubscriptions({
        targetPlanId: plan.openmeterPlanId,
        targetPlanKey: plan.key,
      })
    : null;

  return {
    ownerStarterIncludedUsdMicros: settings.ownerStarterIncludedUsdMicros,
    planKey: plan.key,
    openmeterPlanId: plan.openmeterPlanId,
    migrate,
    resyncSubscribers,
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
      const ensured = await ensureOwnerStarterSubscription({ ownerUserId });
      if (
        ensured.openmeterSubscriptionId &&
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
  if (listed.eligible === 0 && listed.stats.errors === 0) {
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
