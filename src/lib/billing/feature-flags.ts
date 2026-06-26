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
 * Gate the durable, idempotent, acked OpenMeter write on the synchronous
 * signed-ticket ingest endpoint (`POST /api/v1/internal/ingest/signed-ticket`).
 *
 * Default OFF: flag-off keeps the endpoint diagnostic-only (writes a receipt,
 * returns `ingested:false`, never touches OpenMeter) — byte-identical to the
 * legacy behavior, so the existing Kafka → Benthos → OpenMeter pipeline remains
 * the only metering path and there is zero regression.
 *
 * Flip `SIGNED_TICKET_DURABLE_INGEST=1` to make the endpoint synchronously write
 * the `create_signed_ticket` CloudEvent to OpenMeter and ACK with
 * `ingested:true` only after the write is accepted. The write is idempotent on
 * `(clientId, requestId)` (receipts table) and on the CloudEvent `id`
 * (OpenMeter's own dedupe), so it is safe to run in parallel with the legacy
 * Kafka path during rollout without double-counting.
 */
export function durableSignedTicketIngestEnabled(): boolean {
  return envFlag("SIGNED_TICKET_DURABLE_INGEST", false);
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
