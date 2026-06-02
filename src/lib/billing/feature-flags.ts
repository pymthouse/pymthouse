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

/** Signer proxy writes signed-ticket usage to OpenMeter via ingest module. */
export function signerProxyApiIngestEnabled(): boolean {
  return envFlag("SIGNER_PROXY_API_INGEST", true);
}

/** Use stable app-scoped OpenMeter feature keys (not plan-scoped). */
export function billingStableFeatureKeysEnabled(): boolean {
  return envFlag("BILLING_STABLE_FEATURE_KEYS", true);
}
