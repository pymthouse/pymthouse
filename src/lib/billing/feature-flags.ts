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
