import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { planCapabilityBundles, plans } from "@/db/schema";
import {
  applyRetailRateToNetworkMicros,
  resolveEffectiveRetailRateUsd,
} from "./retail-estimate";

export type RetailRateLookup = {
  defaultRateUsd: string;
  byPipeline: Map<string, string>;
  byPipelineModel: Map<string, string>;
};

export async function loadActiveRetailRatesForApp(
  clientId: string,
): Promise<RetailRateLookup> {
  const activePlans = await db
    .select()
    .from(plans)
    .where(and(eq(plans.clientId, clientId), eq(plans.status, "active")));

  const paid = activePlans.filter(
    (p) => !p.isNetworkDefault && !p.isStarterDefault && p.type !== "free",
  );
  const plan = paid.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )[0];

  if (!plan) {
    const fallback = resolveEffectiveRetailRateUsd({
      capabilityRetailRateUsd: null,
      planOverageRateUsd: null,
    });
    return {
      defaultRateUsd: fallback,
      byPipeline: new Map(),
      byPipelineModel: new Map(),
    };
  }

  const caps = await db
    .select()
    .from(planCapabilityBundles)
    .where(eq(planCapabilityBundles.planId, plan.id));

  const byPipeline = new Map<string, string>();
  const byPipelineModel = new Map<string, string>();
  for (const cap of caps) {
    const rate = resolveEffectiveRetailRateUsd({
      capabilityRetailRateUsd: cap.retailRateUsd,
      planOverageRateUsd: plan.overageRateUsd,
    });
    byPipeline.set(cap.pipeline, rate);
    byPipelineModel.set(`${cap.pipeline}|${cap.modelId}`, rate);
  }

  return {
    defaultRateUsd: resolveEffectiveRetailRateUsd({
      capabilityRetailRateUsd: null,
      planOverageRateUsd: plan.overageRateUsd,
    }),
    byPipeline,
    byPipelineModel,
  };
}

export function resolveRetailRateForUsage(input: {
  lookup: RetailRateLookup;
  pipeline?: string;
  modelId?: string;
}): string {
  if (input.pipeline && input.modelId) {
    const exact = input.lookup.byPipelineModel.get(`${input.pipeline}|${input.modelId}`);
    if (exact) {
      return exact;
    }
    const wildcard = input.lookup.byPipelineModel.get(`${input.pipeline}|*`);
    if (wildcard) {
      return wildcard;
    }
  }
  if (input.pipeline) {
    const pipelineRate = input.lookup.byPipeline.get(input.pipeline);
    if (pipelineRate) {
      return pipelineRate;
    }
  }
  return input.lookup.defaultRateUsd;
}

export function estimateEndUserBillableMicros(input: {
  networkFeeUsdMicros: bigint;
  lookup: RetailRateLookup;
  pipeline?: string;
  modelId?: string;
}): string {
  const rate = resolveRetailRateForUsage({
    lookup: input.lookup,
    pipeline: input.pipeline,
    modelId: input.modelId,
  });
  return applyRetailRateToNetworkMicros(input.networkFeeUsdMicros, rate).toString();
}
