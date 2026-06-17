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
 * Gate the neutral BPP ⑥ usage push (pymthouse → NaaP `/metrics/ingest`).
 * Default OFF: flag-off is a strict no-op (zero regression). Flip
 * `USAGE_INGEST_PUSH=1` once NaaP's ingest endpoint + token are provisioned.
 */
export function usageIngestPushEnabled(): boolean {
  return envFlag("USAGE_INGEST_PUSH", false);
}

/**
 * Gate the C0-conformant BPP ② `validate` shape (PYMT-3).
 *
 * The legacy `GET /api/v1/auth/validate` (client_id / plan / allowedModels) is
 * UNCHANGED and always available for current consumers. This flag only controls
 * the NEW, additive `POST /api/v1/auth/validate` which returns the fully reshaped
 * C0 body (`user.sub` / `billing_account` / `capabilities` as `pipeline:model`).
 *
 * Default OFF: flag-off makes the new POST behave as if absent (404), so there is
 * zero regression for the legacy GET path. Flip `BPP_VALIDATE_V2=1` only once the
 * NaaP front door (NAAP-C) is ready to consume the C0 shape (gated by D0).
 */
export function bppValidateV2Enabled(): boolean {
  return envFlag("BPP_VALIDATE_V2", false);
}
