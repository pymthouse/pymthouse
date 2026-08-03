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
 * Pass `platformDefaultMicros` from `resolvePlatformOwnerStarterIncludedUsdMicros`
 * so amount-keyed vs base-key classification matches the DB/env default, not a
 * stale sync env read. When omitted, falls back to the env/hardcoded M2M helper
 * (tests and sync-only call sites).
 *
 * See docs/adr-owner-vs-app-billing.md.
 */
export function ownerStarterPlanKeyForAmount(
  includedUsdMicros: string,
  platformDefaultMicros: string = defaultStarterIncludedUsdMicros(),
): string {
  const trimmed = includedUsdMicros.trim();
  const defaultMicros = platformDefaultMicros.trim();
  if (!/^\d+$/.test(trimmed) || trimmed === defaultMicros) {
    return OWNER_STARTER_PLAN_KEY;
  }
  return `${OWNER_STARTER_PLAN_KEY}_${trimmed}`;
}

/** True when `planKey` is exactly the shared base Owner Starter key (not an amount variant). */
export function isBaseOwnerStarterPlanKey(
  planKey: string | null | undefined,
): boolean {
  const key = planKey?.trim();
  if (!key) return false;
  return key.toLowerCase() === OWNER_STARTER_PLAN_KEY.toLowerCase();
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

/**
 * Sync env/hardcoded Owner Starter default — bootstrap only.
 * Prefer `resolvePlatformOwnerStarterIncludedUsdMicros()` on async Owner paths.
 */
export function ownerStarterIncludedUsdMicros(): string {
  return defaultStarterIncludedUsdMicros();
}
