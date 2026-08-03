import { eq, or } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerBillingConfig, users } from "@/db/schema";
import { setPlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import {
  changeKonnectSubscription,
  listActiveKonnectSubscriptions,
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
  migrate: BaseOwnerStarterMigrateStats;
};

/**
 * Persist the new platform Owner Starter default, republish the shared base
 * plan, and migrate every active subscription still on that base key (not
 * amount-keyed override plans).
 */
export async function republishAndMigrateBaseOwnerStarter(input: {
  ownerStarterIncludedUsdMicros: string;
  updatedBy: string;
}): Promise<RepublishBaseOwnerStarterResult> {
  const settings = await setPlatformOwnerStarterIncludedUsdMicros({
    ownerStarterIncludedUsdMicros: input.ownerStarterIncludedUsdMicros,
    updatedBy: input.updatedBy,
  });
  invalidateOwnerStarterPlanCache();

  const plan = await forceSyncOwnerStarterPlan(
    settings.ownerStarterIncludedUsdMicros,
  );

  const migrate = await migrateBaseOwnerStarterSubscriptions({
    targetPlanId: plan.openmeterPlanId,
    targetPlanKey: plan.key,
  });

  return {
    ownerStarterIncludedUsdMicros: settings.ownerStarterIncludedUsdMicros,
    planKey: plan.key,
    openmeterPlanId: plan.openmeterPlanId,
    migrate,
  };
}

async function migrateBaseOwnerStarterSubscriptions(input: {
  targetPlanId: string;
  targetPlanKey: string;
}): Promise<BaseOwnerStarterMigrateStats> {
  const stats: BaseOwnerStarterMigrateStats = {
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  if (!isHostedAdminClientAvailable()) {
    return stats;
  }

  const client = getHostedAdminClient();
  let eligibleFromList = 0;

  try {
    const active = await listActiveKonnectSubscriptions();
    for (const sub of active) {
      const planId = sub.plan_id?.trim() || sub.planId?.trim() || "";
      if (!planId || !sub.id || !sub.customer_id) {
        continue;
      }
      if (planId === input.targetPlanId) {
        stats.skipped += 1;
        continue;
      }

      let planKey: string | null = null;
      try {
        const plan = await client.plans.get(planId);
        planKey = plan?.key?.trim() ?? null;
      } catch {
        stats.errors += 1;
        continue;
      }

      if (!isBaseOwnerStarterPlanKey(planKey)) {
        continue;
      }

      eligibleFromList += 1;
      try {
        await changeKonnectSubscription({
          subscriptionId: sub.id,
          customerId: sub.customer_id,
          planId: input.targetPlanId,
          timing: "immediate",
        });
        stats.updated += 1;
      } catch (err) {
        console.warn(
          "openmeter: base owner starter migrate failed",
          sub.id,
          err instanceof Error ? err.message : String(err),
        );
        stats.errors += 1;
      }
    }
  } catch (err) {
    console.warn(
      "openmeter: list active subscriptions for base owner starter migrate failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Konnect's global /subscriptions index often omits rows; fall back to
  // owners without a starter override (they should be on the base key).
  if (eligibleFromList === 0 && stats.errors === 0) {
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
      } catch (err) {
        console.warn(
          "openmeter: owner wallet base starter ensure failed",
          ownerUserId,
          err instanceof Error ? err.message : String(err),
        );
        stats.errors += 1;
      }
    }
  }

  return stats;
}

/** Developers/admins with no starter_included override (still on the shared base plan). */
async function listOwnersOnPlatformDefaultStarter(): Promise<string[]> {
  const withOverride = await db
    .select({
      ownerUserId: ownerBillingConfig.ownerUserId,
      starterIncludedUsdMicros: ownerBillingConfig.starterIncludedUsdMicros,
    })
    .from(ownerBillingConfig);

  const overridden = new Set(
    withOverride
      .filter((r) => {
        const m = r.starterIncludedUsdMicros?.trim();
        return Boolean(m && /^\d+$/.test(m));
      })
      .map((r) => r.ownerUserId),
  );

  const all = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.role, "developer"), eq(users.role, "admin")));

  return all.map((r) => r.id).filter((id) => !overridden.has(id));
}
