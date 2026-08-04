/** Platform Owner Paid plan keys (Stripe-collectible cost rail after Upgrade). */

export const OWNER_PAID_PLAN_KEY =
  process.env.OPENMETER_OWNER_PAID_PLAN_KEY?.trim() || "pymthouse_owner_paid";

export const OWNER_PAID_PLAN_NAME = "Owner Paid";

/** Prefix for admin-created Paid tiers (`pymthouse_owner_paid` or `pymthouse_owner_paid_*`). */
export const OWNER_PAID_PLAN_KEY_PREFIX = "pymthouse_owner_paid";

/**
 * True when a Konnect plan key is an Owner Paid tier (legacy single key or
 * `pymthouse_owner_paid_<slug>`).
 */
export function isOwnerPaidPlanKey(planKey: string | null | undefined): boolean {
  const key = planKey?.trim().toLowerCase();
  if (!key) return false;
  if (key === OWNER_PAID_PLAN_KEY.toLowerCase()) return true;
  if (key === OWNER_PAID_PLAN_KEY_PREFIX) return true;
  return key.startsWith(`${OWNER_PAID_PLAN_KEY_PREFIX}_`);
}

/** Validate an admin-supplied Owner Paid tier key. */
export function isValidOwnerPaidTierKey(planKey: string): boolean {
  const key = planKey.trim().toLowerCase();
  // Allow the configured env key (may be a legacy non-prefix value).
  if (key === OWNER_PAID_PLAN_KEY.toLowerCase()) return true;
  if (key === OWNER_PAID_PLAN_KEY_PREFIX) return true;
  return /^pymthouse_owner_paid_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key);
}
