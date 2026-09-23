import {
  listDiscoveryProfileBundlesByProfileIds,
  listDiscoveryProfilesByIds,
} from "../repo/discovery-profiles";
import {
  listPlanCapabilityBundlesByClientId,
  listPlansByClientId,
} from "../repo/plans";
import type { DiscoveryPolicy } from "@/shared/discovery/discovery-plans";
import { discoveryPolicyFromDb } from "@/shared/discovery/discovery-plans";

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
  plan: Awaited<ReturnType<typeof listPlansByClientId>>[number];
  discoveryProfileId: string | null;
  discoveryPolicy: DiscoveryPolicy | null;
  capabilities: ResolvedPlanCapability[];
};

function bundleLookupKey(pipeline: string, modelId: string): string {
  return `${pipeline}\0${modelId}`;
}

export async function resolvePlansDiscoveryForApp(appId: string): Promise<ResolvedPlanRow[]> {
  const planRows = await listPlansByClientId(appId);
  const billingBundles = await listPlanCapabilityBundlesByClientId(appId);

  const profileIds = [
    ...new Set(planRows.map((p) => p.discoveryProfileId).filter(Boolean)),
  ] as string[];

  const profiles = await listDiscoveryProfilesByIds(profileIds);
  const profById = new Map(profiles.map((p) => [p.id, p]));

  const discBundles = await listDiscoveryProfileBundlesByProfileIds(profileIds);
  const discByProfile = new Map<string, Map<string, (typeof discBundles)[0]>>();
  for (const row of discBundles) {
    if (!discByProfile.has(row.profileId)) {
      discByProfile.set(row.profileId, new Map());
    }
    discByProfile.get(row.profileId)!.set(bundleLookupKey(row.pipeline, row.modelId), row);
  }

  const bundlesByPlan = new Map<string, (typeof billingBundles)[number][]>();
  for (const b of billingBundles) {
    const list = bundlesByPlan.get(b.planId);
    if (list) list.push(b);
    else bundlesByPlan.set(b.planId, [b]);
  }

  return planRows.map((plan) => {
    const prof = plan.discoveryProfileId ? profById.get(plan.discoveryProfileId) : undefined;
    const planLevel = prof ? discoveryPolicyFromDb(prof.policy) : null;
    const dMap = plan.discoveryProfileId ? discByProfile.get(plan.discoveryProfileId) : undefined;

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
