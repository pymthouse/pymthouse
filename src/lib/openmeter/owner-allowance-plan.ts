import type { OpenMeter } from "@openmeter/sdk";

import { defaultRetailRateUsd } from "@/lib/plan-pricing";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import {
  DEFAULT_TRIAL_FEATURE_KEY,
  getHostedOpenMeterUrl,
  KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
  NETWORK_FEE_USD_MICROS_METER,
} from "./constants";
import { buildKonnectUsageRateCard } from "./konnect-plan-body";
import {
  ensureKonnectTenantCatalog,
  findKonnectFeatureIdByKey,
} from "./konnect-catalog";
import {
  isOpenMeterConflictError,
  isOpenMeterPlanAlreadyPublishedError,
  isOpenMeterPlanImmutableError,
  isOpenMeterPlanNotFoundError,
} from "./plan-errors";
import { shouldUseKonnectRoutes } from "./route-mode";

export type FoundOpenMeterPlan = {
  id: string;
  key?: string;
  version?: number;
  status?: string;
};

export type OwnerAllowancePlanRef = {
  key: string;
  openmeterPlanId: string;
  includedUsdMicros: string;
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

/** Read discounts.usage from an OpenMeter/Konnect plan body (SDK or raw). */
export function readUsageDiscountUsdMicrosFromPlanBody(
  plan: unknown,
): string | null {
  if (!plan || typeof plan !== "object") return null;
  const phases = readPlanPhases(plan);
  if (!phases) return null;

  for (const phase of phases) {
    const micros = readUsageDiscountFromPhase(phase);
    if (micros != null) return micros;
  }
  return null;
}

function readPlanPhases(plan: object): unknown[] | null {
  const phases =
    (plan as { phases?: unknown }).phases ??
    (plan as { Phases?: unknown }).Phases;
  return Array.isArray(phases) ? phases : null;
}

function readUsageDiscountFromPhase(phase: unknown): string | null {
  if (!phase || typeof phase !== "object") return null;
  const cards =
    (phase as { rateCards?: unknown }).rateCards ??
    (phase as { rate_cards?: unknown }).rate_cards ??
    [];
  if (!Array.isArray(cards)) return null;
  for (const card of cards) {
    const micros = readUsageDiscountFromRateCard(card);
    if (micros != null) return micros;
  }
  return null;
}

function readUsageDiscountFromRateCard(card: unknown): string | null {
  if (!card || typeof card !== "object") return null;
  const discounts = (card as { discounts?: unknown }).discounts;
  if (!discounts || typeof discounts !== "object") return null;
  const usage =
    (discounts as { usage?: unknown }).usage ??
    (discounts as { Usage?: unknown }).Usage;
  if (typeof usage === "number" && Number.isFinite(usage)) {
    return String(Math.trunc(usage));
  }
  if (typeof usage === "string" && /^\d+$/.test(usage.trim())) {
    return usage.trim();
  }
  return null;
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

/**
 * Force-update (or create) an owner allowance plan and publish it.
 * Published versions are immutable — falls back to a new draft under the same key.
 */
export async function forceSyncOwnerAllowancePlanWithClient(
  client: OpenMeter,
  input: {
    planKey: string;
    planName: string;
    planKind: "owner_starter" | "owner_paid";
    featureId: string;
    includedUsdMicros: string;
    warnLabel: string;
  },
): Promise<OwnerAllowancePlanRef> {
  const amount = input.includedUsdMicros.trim();
  const body = buildOwnerAllowancePlanBody({
    planKey: input.planKey,
    planName: input.planName,
    planKind: input.planKind,
    featureId: input.featureId,
    includedUsdMicros: parseOwnerAllowanceIncludedMicros(amount),
    unitAmount: defaultRetailRateUsd(),
  });

  const existing = await findOpenMeterPlanByKey(client, input.planKey);
  let openmeterPlanId = existing?.id;
  const createFailedMessage = `Failed to create ${input.planName} plan`;

  if (openmeterPlanId) {
    try {
      const updated = await client.plans.update(
        openmeterPlanId,
        body as unknown as Parameters<OpenMeter["plans"]["update"]>[1],
      );
      openmeterPlanId = updated?.id ?? openmeterPlanId;
    } catch (updateErr) {
      if (
        !isOpenMeterPlanNotFoundError(updateErr) &&
        !isOpenMeterPlanImmutableError(updateErr)
      ) {
        throw updateErr;
      }
      // Published versions are immutable — create a new draft under the same key.
      openmeterPlanId = await createOwnerAllowancePlan({
        client,
        planKey: input.planKey,
        planName: input.planName,
        planKind: input.planKind,
        featureId: input.featureId,
        includedUsdMicros: amount,
        createFailedMessage,
      });
    }
  } else {
    openmeterPlanId = await createOwnerAllowancePlan({
      client,
      planKey: input.planKey,
      planName: input.planName,
      planKind: input.planKind,
      featureId: input.featureId,
      includedUsdMicros: amount,
      createFailedMessage,
    });
  }

  openmeterPlanId = await publishOpenMeterPlanBestEffort(
    client,
    openmeterPlanId,
    input.warnLabel,
  );

  return {
    key: input.planKey,
    openmeterPlanId,
    includedUsdMicros: amount,
  };
}

/**
 * Force-update (or create) an owner allowance plan and publish it.
 * Published versions are immutable — falls back to a new draft under the same key.
 */
export async function forceSyncOwnerAllowancePlan(input: {
  planKey: string;
  planName: string;
  planKind: "owner_starter" | "owner_paid";
  includedUsdMicros: string;
  warnLabel: string;
}): Promise<OwnerAllowancePlanRef> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }

  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey);
  if (!useKonnect) {
    throw new Error(
      `${input.warnLabel} plan requires Konnect metering routes`,
    );
  }

  const client = getHostedAdminClient();
  await ensureKonnectTenantCatalog();
  const featureId = await findKonnectFeatureIdByKey(DEFAULT_TRIAL_FEATURE_KEY);
  if (!featureId) {
    throw new Error(`Konnect feature missing: ${DEFAULT_TRIAL_FEATURE_KEY}`);
  }

  return forceSyncOwnerAllowancePlanWithClient(client, {
    planKey: input.planKey,
    planName: input.planName,
    planKind: input.planKind,
    featureId,
    includedUsdMicros: input.includedUsdMicros,
    warnLabel: input.warnLabel,
  });
}
