/** Feature flags for billing API rollout and signer decoupling. */

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

/** Return BillingProduct DTOs from GET /plans (hides raw OpenMeter ids by default). */
export function billingPlansApiV2Enabled(): boolean {
  return envFlag("BILLING_PLANS_API_V2", true);
}

/** Use stable app-scoped OpenMeter feature keys (not plan-scoped). */
export function billingStableFeatureKeysEnabled(): boolean {
  return envFlag("BILLING_STABLE_FEATURE_KEYS", true);
}

/**
 * Gate the C0-conformant BPP ② `validate` shape (PYMT-3).
 *
 * `GET /api/v1/auth/validate` was removed. This flag controls
 * `POST /api/v1/auth/validate` which returns the C0 body
 * (`user.sub` / `billing_account` / `capabilities` as `pipeline:model`).
 *
 * Default OFF: flag-off returns 404. Set `BPP_VALIDATE_V2=1` when consumers
 * are ready for the C0 shape.
 */
export function bppValidateV2Enabled(): boolean {
  return envFlag("BPP_VALIDATE_V2", false);
}
