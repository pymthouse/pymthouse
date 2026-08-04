/** Platform Owner Paid plan keys (Stripe-collectible cost rail after PM attach). */

export const OWNER_PAID_PLAN_KEY =
  process.env.OPENMETER_OWNER_PAID_PLAN_KEY?.trim() || "pymthouse_owner_paid";

export const OWNER_PAID_PLAN_NAME = "Owner Paid";

export function isOwnerPaidPlanKey(planKey: string | null | undefined): boolean {
  const key = planKey?.trim();
  if (!key) return false;
  return key.toLowerCase() === OWNER_PAID_PLAN_KEY.toLowerCase();
}
