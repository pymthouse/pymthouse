import type { OpenMeter } from "@openmeter/sdk";

import { defaultRetailRateUsd } from "@/lib/plan-pricing";
import {
  DEFAULT_TRIAL_FEATURE_KEY,
  KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
  NETWORK_FEE_USD_MICROS_METER,
} from "./constants";
import { buildKonnectUsageRateCard } from "./konnect-plan-body";
import {
  isOpenMeterConflictError,
  isOpenMeterPlanAlreadyPublishedError,
} from "./plan-errors";

export type FoundOpenMeterPlan = {
  id: string;
  key?: string;
  version?: number;
  status?: string;
};

export function parseOwnerAllowanceIncludedMicros(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 5_000_000;
  }
  return Math.floor(n);
}

export function buildOwnerAllowancePlanBody(input: {
  planKey: string;
  planName: string;
  planKind: "owner_starter" | "owner_paid";
  featureId: string;
  includedUsdMicros: number;
  unitAmount: string;
}): Record<string, unknown> {
  return {
    key: input.planKey,
    name: input.planName,
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
      pymthouse_plan_kind: input.planKind,
      meter_slug: NETWORK_FEE_USD_MICROS_METER,
    },
  };
}

export async function findOpenMeterPlanByKey(
  client: OpenMeter,
  planKey: string,
): Promise<FoundOpenMeterPlan | null> {
  try {
    const listed = await client.plans.list({
      ...({ key: planKey } as Record<string, unknown>),
      page: 1,
      pageSize: 50,
    } as Parameters<OpenMeter["plans"]["list"]>[0]);
    const items = (listed as { items?: Array<FoundOpenMeterPlan> })?.items ?? [];
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

/** Publish is only legal for these plan states; any other state is already live. */
export function openMeterPlanNeedsPublish(status: string | undefined): boolean {
  return status === "draft" || status === "scheduled";
}

export async function publishOpenMeterPlanBestEffort(
  client: OpenMeter,
  planId: string,
  warnLabel: string,
): Promise<string> {
  try {
    const published = await client.plans.publish(planId);
    return published?.id ?? planId;
  } catch (err) {
    if (
      !isOpenMeterConflictError(err) &&
      !isOpenMeterPlanAlreadyPublishedError(err)
    ) {
      console.warn(`openmeter: ${warnLabel} plan publish failed`);
    }
    return planId;
  }
}

export async function createOwnerAllowancePlan(input: {
  client: OpenMeter;
  planKey: string;
  planName: string;
  planKind: "owner_starter" | "owner_paid";
  featureId: string;
  includedUsdMicros: string;
  createFailedMessage: string;
}): Promise<string> {
  const body = buildOwnerAllowancePlanBody({
    planKey: input.planKey,
    planName: input.planName,
    planKind: input.planKind,
    featureId: input.featureId,
    includedUsdMicros: parseOwnerAllowanceIncludedMicros(input.includedUsdMicros),
    unitAmount: defaultRetailRateUsd(),
  });

  try {
    const created = await input.client.plans.create(
      body as unknown as Parameters<OpenMeter["plans"]["create"]>[0],
    );
    if (!created?.id) {
      throw new Error(input.createFailedMessage);
    }
    return created.id;
  } catch (err) {
    if (!isOpenMeterConflictError(err)) {
      throw err;
    }
    const raced = await findOpenMeterPlanByKey(input.client, input.planKey);
    if (!raced?.id) {
      throw err;
    }
    return raced.id;
  }
}
