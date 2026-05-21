export interface PlanCapabilityInput {
  pipeline: string;
  modelId: string;
  slaTargetScore: number | null;
  slaTargetP95Ms: number | null;
  maxPricePerUnit: string | null;
  upchargePercentBps: number | null;
}

export interface CreatePlanInput {
  name: string;
  type: string;
  priceAmount: string;
  priceCurrency: string;
  status: string;
  includedUnits: string | null;
  overageRateWei: string | null;
  includedUsdMicros: string | null;
  generalUpchargePercentBps: number | null;
  payPerUseUpchargePercentBps: number | null;
  billingCycle: string;
  discoveryProfileId: string | null;
  capabilities: PlanCapabilityInput[];
}

export interface UpdatePlanInput {
  id: string;
  name?: string;
  type?: string;
  priceAmount?: string;
  priceCurrency?: string;
  status?: string;
  includedUnits?: string | null;
  overageRateWei?: string | null;
  includedUsdMicros?: string | null;
  generalUpchargePercentBps?: number | null;
  payPerUseUpchargePercentBps?: number | null;
  billingCycle?: string;
  discoveryProfileId?: string | null;
  capabilities?: PlanCapabilityInput[];
}
