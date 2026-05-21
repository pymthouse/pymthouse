import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/index";
import {
  discoveryProfileBundles,
  discoveryProfiles,
  planCapabilityBundles,
  plans,
} from "@/db/schema";
import type { DiscoveryPolicy } from "@/lib/discovery-plans";
import { discoveryPolicyFromDb } from "@/lib/discovery-plans";

export type ResolvedPlanCapability = {
  id: string;
  planId: string;
  clientId: string;
  pipeline: string;
  modelId: string;
  slaTargetScore: number | null;
  slaTargetP95Ms: number | null;
  maxPricePerUnit: string | null;
  upchargePercentBps: number | null;
  createdAt: string;
  discoveryPolicy: DiscoveryPolicy | null;
};

export type ResolvedPlanRow = {
  plan: typeof plans.$inferSelect;
  discoveryProfileId: string | null;
  discoveryPolicy: DiscoveryPolicy | null;
  capabilities: ResolvedPlanCapability[];
};

function bundleLookupKey(pipeline: string, modelId: string): string {
  return `${pipeline}\0${modelId}`;
}

/**
 * Load all plans for an app with discovery resolved from linked discovery profiles.
 * Billing bundles define pipeline/model rows; per-row discovery comes from matching
 * `discovery_profile_bundles` rows (not from billing bundle columns).
 */
export async function resolvePlansDiscoveryForApp(
  appId: string,
): Promise<ResolvedPlanRow[]> {
  const planRows = await db.select().from(plans).where(eq(plans.clientId, appId));
  const billingBundles = await db
    .select()
    .from(planCapabilityBundles)
    .where(eq(planCapabilityBundles.clientId, appId));

  const profileIds = [
    ...new Set(planRows.map((p) => p.discoveryProfileId).filter(Boolean)),
  ] as string[];

  const profiles =
    profileIds.length > 0
      ? await db
          .select()
          .from(discoveryProfiles)
          .where(inArray(discoveryProfiles.id, profileIds))
      : [];
  const profById = new Map(profiles.map((p) => [p.id, p]));

  const discBundles =
    profileIds.length > 0
      ? await db
          .select()
          .from(discoveryProfileBundles)
          .where(inArray(discoveryProfileBundles.profileId, profileIds))
      : [];

  const discByProfile = new Map<string, Map<string, (typeof discBundles)[0]>>();
  for (const row of discBundles) {
    if (!discByProfile.has(row.profileId)) {
      discByProfile.set(row.profileId, new Map());
    }
    discByProfile
      .get(row.profileId)!
      .set(bundleLookupKey(row.pipeline, row.modelId), row);
  }

  const bundlesByPlan = new Map<string, (typeof billingBundles)[number][]>();
  for (const b of billingBundles) {
    const list = bundlesByPlan.get(b.planId);
    if (list) {
      list.push(b);
    } else {
      bundlesByPlan.set(b.planId, [b]);
    }
  }

  return planRows.map((plan) => {
    const prof = plan.discoveryProfileId ? profById.get(plan.discoveryProfileId) : undefined;
    const planLevel = prof ? discoveryPolicyFromDb(prof.policy) : null;
    const dMap = plan.discoveryProfileId
      ? discByProfile.get(plan.discoveryProfileId)
      : undefined;

    const capabilities: ResolvedPlanCapability[] = (bundlesByPlan.get(plan.id) ?? []).map(
      (bundle) => {
        const discRow = dMap?.get(bundleLookupKey(bundle.pipeline, bundle.modelId));
        return {
          id: bundle.id,
          planId: bundle.planId,
          clientId: bundle.clientId,
          pipeline: bundle.pipeline,
          modelId: bundle.modelId,
          slaTargetScore: bundle.slaTargetScore,
          slaTargetP95Ms: bundle.slaTargetP95Ms,
          maxPricePerUnit: bundle.maxPricePerUnit,
          upchargePercentBps: bundle.upchargePercentBps,
          createdAt: bundle.createdAt,
          discoveryPolicy: discRow ? discoveryPolicyFromDb(discRow.discoveryPolicy) : null,
        };
      },
    );

    return {
      plan,
      discoveryProfileId: plan.discoveryProfileId ?? null,
      discoveryPolicy: planLevel,
      capabilities,
    };
  });
}
