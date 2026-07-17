import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";

/** Platform-wide Owner Starter plan key (shared across all owner wallets). */
export const OWNER_STARTER_PLAN_KEY =
  process.env.OPENMETER_OWNER_STARTER_PLAN_KEY?.trim() || "pymthouse_owner_starter";

export const OWNER_STARTER_PLAN_NAME = "Owner Starter";

export function isOwnerStarterPlanKey(planKey: string | null | undefined): boolean {
  const key = planKey?.trim();
  if (!key) return false;
  return key === OWNER_STARTER_PLAN_KEY || key.toLowerCase() === OWNER_STARTER_PLAN_KEY.toLowerCase();
}

/** Included usage discount for the platform Owner Starter plan. */
export function ownerStarterIncludedUsdMicros(): string {
  return defaultStarterIncludedUsdMicros();
}
