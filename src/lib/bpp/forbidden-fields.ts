/**
 * BPP seam isolation — provider-internal field-name guard.
 *
 * pymthouse meters internally with OpenMeter / Kong Konnect (BPP ⑨). Those
 * provider-internal field names MUST NEVER cross a NaaP-facing BPP seam — e.g.
 * the ② `validate` response or any OpenMeter-backed usage that NaaP reads (pulls)
 * from pymthouse. NaaP must stay agnostic of the metering backend.
 *
 * This list mirrors `x-bpp-forbidden-field-names` in
 * `contracts/billing-provider-protocol/provider-internal-openmeter.schema.json`
 * (the C0 contract). The conformance suite on the NaaP side rejects any payload
 * containing these names; this module lets pymthouse assert the same invariant at
 * the producing edge (defense in depth) and in unit tests.
 */

/**
 * Provider-internal field names that MUST NOT appear on a BPP seam.
 * Kept in sync with the C0 `provider-internal-openmeter.schema.json`.
 */
export const FORBIDDEN_INTERNAL_FIELD_NAMES: readonly string[] = [
  "openmeter_subscription_id",
  "openmeter_customer_id",
  "network_fee_usd_nanos",
  "fee_wei",
  "eth_usd_price",
  "eth_usd_round_id",
  "eth_usd_observed_at",
  "external_user_id",
  "client_id",
  "model_id",
  "gateway_request_id",
  "specversion",
];

const FORBIDDEN_SET = new Set(FORBIDDEN_INTERNAL_FIELD_NAMES);

/**
 * Recursively collect any provider-internal field NAMES present as object keys in
 * `value`. Only keys are inspected — neutral string values (e.g. a
 * `"text-to-image:sdxl"` capability id) are allowed.
 */
export function findLeakedInternalFieldNames(
  value: unknown,
  acc: Set<string> = new Set(),
): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      findLeakedInternalFieldNames(item, acc);
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_SET.has(key)) {
        acc.add(key);
      }
      findLeakedInternalFieldNames(child, acc);
    }
  }
  return [...acc];
}

/**
 * Throw if `value` contains any provider-internal field name. Used as a
 * producing-edge guard before a payload leaves pymthouse on a BPP seam.
 */
export function assertNoLeakedInternalFieldNames(value: unknown, context: string): void {
  const leaked = findLeakedInternalFieldNames(value);
  if (leaked.length > 0) {
    throw new Error(
      `BPP seam isolation violation (${context}): provider-internal field names leaked: ${leaked.join(", ")}`,
    );
  }
}
