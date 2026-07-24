/** App-facing billing cycle values stored on `plans.billing_cycle`. */
export const PLAN_BILLING_CYCLES = ["daily", "weekly", "monthly"] as const;

export type PlanBillingCycle = (typeof PLAN_BILLING_CYCLES)[number];

const DEFAULT_BILLING_CYCLE: PlanBillingCycle = "monthly";

/** OpenMeter / Konnect ISO-8601 billing cadence for each app cycle. */
const BILLING_CYCLE_TO_OPENMETER_CADENCE: Record<PlanBillingCycle, string> = {
  daily: "P1D",
  weekly: "P1W",
  monthly: "P1M",
};

export function isPlanBillingCycle(value: string): value is PlanBillingCycle {
  return (PLAN_BILLING_CYCLES as readonly string[]).includes(value);
}

/** Normalize DB/API cycle strings; unknown values fall back to monthly. */
export function normalizePlanBillingCycle(value: string | null | undefined): PlanBillingCycle {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (isPlanBillingCycle(trimmed)) {
    return trimmed;
  }
  return DEFAULT_BILLING_CYCLE;
}

/** Map a plan billing cycle to OpenMeter `billingCadence` / `billing_cadence`. */
export function billingCycleToOpenMeterCadence(
  value: string | null | undefined,
): string {
  return BILLING_CYCLE_TO_OPENMETER_CADENCE[normalizePlanBillingCycle(value)];
}

export function parsePlanBillingCycleInput(
  value: unknown,
): { ok: true; value: PlanBillingCycle } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: DEFAULT_BILLING_CYCLE };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      error: `billingCycle must be one of: ${PLAN_BILLING_CYCLES.join(", ")}`,
    };
  }
  const normalized = value.trim().toLowerCase();
  if (!isPlanBillingCycle(normalized)) {
    return {
      ok: false,
      error: `billingCycle must be one of: ${PLAN_BILLING_CYCLES.join(", ")}`,
    };
  }
  return { ok: true, value: normalized };
}
