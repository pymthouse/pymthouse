import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";

/** Platform-wide Owner Starter plan key (shared across all owner wallets). */
export const OWNER_STARTER_PLAN_KEY =
  process.env.OPENMETER_OWNER_STARTER_PLAN_KEY?.trim() || "pymthouse_owner_starter";

export const OWNER_STARTER_PLAN_NAME = "Owner Starter";

/**
 * Plan key for a given included allowance.
 *
 * Keyed by **amount**, not by owner: every owner on the platform default shares
 * `pymthouse_owner_starter`, and each distinct override amount gets one plan
 * (`pymthouse_owner_starter_50000000`). Plan count is therefore bounded by the
 * number of distinct allowances, not by the number of developers.
 *
 * The allowance is baked into the plan's `discounts.usage`, so an owner whose
 * override is not reflected in their plan would be shown an allowance OpenMeter
 * will not honour when invoicing. Resolving key and amount together is what
 * keeps the two in step. See docs/adr-owner-vs-app-billing.md.
 */
export function ownerStarterPlanKeyForAmount(
  includedUsdMicros: string,
): string {
  const trimmed = includedUsdMicros.trim();
  if (!/^\d+$/.test(trimmed) || trimmed === defaultStarterIncludedUsdMicros()) {
    return OWNER_STARTER_PLAN_KEY;
  }
  return `${OWNER_STARTER_PLAN_KEY}_${trimmed}`;
}

export function isOwnerStarterPlanKey(planKey: string | null | undefined): boolean {
  const key = planKey?.trim();
  if (!key) return false;
  const base = OWNER_STARTER_PLAN_KEY.toLowerCase();
  const lower = key.toLowerCase();
  // Per-amount variants are still Owner Starter plans; matching only the base
  // key would make an overridden owner look unsubscribed to every caller that
  // classifies plans by this predicate.
  return lower === base || new RegExp(`^${base}_\\d+$`).test(lower);
}

/** Included usage discount for the platform-default Owner Starter plan. */
export function ownerStarterIncludedUsdMicros(): string {
  return defaultStarterIncludedUsdMicros();
}
