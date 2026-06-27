import type { ResolvedPlanRow } from "@/lib/discovery-profile-resolve";
import { buildAppCapabilityFeatureKey } from "@/lib/openmeter/capability-features";
import type { BillingProduct, BillingSyncState, CapabilityPriceRule } from "./types";
import {
  markupPercentForRetailRate,
  resolveEffectiveRetailRateUsd,
} from "./retail-estimate";

export function deriveSyncState(plan: ResolvedPlanRow["plan"]): BillingSyncState {
  if (plan.type === "free" || plan.isNetworkDefault) {
    return {
      status: "not_applicable",
      syncedAt: plan.lastSyncedAt ?? null,
      errorCode: null,
      errorMessage: null,
    };
  }
  if (plan.syncError) {
    return {
      status: "error",
      syncedAt: plan.lastSyncedAt ?? null,
      errorCode: "sync_failed",
      errorMessage: plan.syncError,
      openmeterPlanId: plan.openmeterPlanId ?? null,
      openmeterPlanVersion: plan.openmeterPlanVersion ?? null,
    };
  }
  if (plan.openmeterPlanId && plan.lastSyncedAt) {
    return {
      status: "synced",
      syncedAt: plan.lastSyncedAt,
      errorCode: null,
      errorMessage: null,
      openmeterPlanId: plan.openmeterPlanId,
      openmeterPlanVersion: plan.openmeterPlanVersion ?? null,
    };
  }
  return {
    status: "pending",
    syncedAt: plan.lastSyncedAt ?? null,
    errorCode: null,
    errorMessage: null,
    openmeterPlanId: plan.openmeterPlanId ?? null,
    openmeterPlanVersion: plan.openmeterPlanVersion ?? null,
  };
}

export function toCapabilityPriceRule(input: {
  clientId: string;
  plan: ResolvedPlanRow["plan"];
  capability: ResolvedPlanRow["capabilities"][0];
}): CapabilityPriceRule {
  const effectiveRetailRateUsd = resolveEffectiveRetailRateUsd({
    capabilityRetailRateUsd: input.capability.retailRateUsd,
    planOverageRateUsd: input.plan.overageRateUsd,
  });
  return {
    pipeline: input.capability.pipeline,
    modelId: input.capability.modelId,
    retailRateUsd: input.capability.retailRateUsd,
    markupPercent: markupPercentForRetailRate(effectiveRetailRateUsd),
    effectiveRetailRateUsd,
    featureKey:
      input.capability.openmeterFeatureKey ??
      buildAppCapabilityFeatureKey({
        clientId: input.clientId,
        pipeline: input.capability.pipeline,
        modelId: input.capability.modelId,
      }),
  };
}

export function toBillingProduct(input: {
  clientId: string;
  resolved: ResolvedPlanRow;
}): BillingProduct {
  const { plan, capabilities, discoveryProfileId, discoveryPolicy } = input.resolved;
  return {
    id: plan.id,
    clientId: input.clientId,
    name: plan.name,
    type: plan.type,
    status: plan.status,
    priceAmount: plan.priceAmount,
    priceCurrency: plan.priceCurrency,
    isNetworkDefault: Boolean(plan.isNetworkDefault),
    isStarterDefault: Boolean(plan.isStarterDefault),
    allowance: {
      includedUsdMicros: plan.includedUsdMicros ?? null,
      billingCycle: plan.billingCycle,
    },
    defaultRetailRateUsd: plan.overageRateUsd ?? null,
    capabilities: capabilities.map((cap) =>
      toCapabilityPriceRule({ clientId: input.clientId, plan, capability: cap }),
    ),
    sync: deriveSyncState(plan),
    discoveryProfileId: discoveryProfileId ?? null,
    discoveryPolicy,
  };
}

export function toPlanApiRow(input: {
  clientId: string;
  resolved: ResolvedPlanRow;
  includeInternals: boolean;
}): Record<string, unknown> {
  const { plan, capabilities, discoveryProfileId, discoveryPolicy } = input.resolved;
  const base: Record<string, unknown> = {
    id: plan.id,
    clientId: input.clientId,
    name: plan.name,
    type: plan.type,
    priceAmount: plan.priceAmount,
    priceCurrency: plan.priceCurrency,
    status: plan.status,
    includedUnits:
      plan.includedUnits !== null && plan.includedUnits !== undefined
        ? plan.includedUnits.toString()
        : null,
    overageRateUsd: plan.overageRateUsd ?? null,
    includedUsdMicros: plan.includedUsdMicros ?? null,
    billingCycle: plan.billingCycle,
    isNetworkDefault: plan.isNetworkDefault,
    isStarterDefault: plan.isStarterDefault,
    discoveryExcludedCapabilities: plan.discoveryExcludedCapabilities ?? null,
    discoveryProfileId: discoveryProfileId ?? null,
    discoveryPolicy,
    capabilities: capabilities.map((c) => ({
      ...c,
      clientId: input.clientId,
    })),
    sync: deriveSyncState(plan),
  };
  if (input.includeInternals) {
    base.openmeterPlanId = plan.openmeterPlanId ?? null;
    base.openmeterPlanVersion = plan.openmeterPlanVersion ?? null;
    base.lastSyncedAt = plan.lastSyncedAt ?? null;
    base.syncError = plan.syncError ?? null;
  }
  return base;
}
