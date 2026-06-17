/**
 * Neutral, provider-opaque `subscriptionRef` for the BPP ② `validate` seam.
 *
 * Background: PR #133 made `validate` OpenMeter-authoritative and (incorrectly)
 * returned the raw `openmeter_subscription_id` — a provider-internal identifier
 * leaking across the BPP boundary. Per the C0 `validate.schema.json`, providers
 * may surface an OPTIONAL `subscriptionRef`: a neutral opaque pointer whose
 * meaning is decided by the provider and which MUST NOT encode a
 * provider-internal identifier name.
 *
 * Design:
 *  - The field name (`subscriptionRef`) is provider-neutral.
 *  - The VALUE is an opaque, stable, provider-decodable token — `subref_` +
 *    base64url(internal id) — so NaaP never observes the raw OpenMeter ULID and
 *    cannot infer the metering backend from it.
 *  - This is opacity, NOT secrecy: the encoding is reversible by design so
 *    pymthouse can map a `subscriptionRef` back to its OpenMeter subscription if
 *    a future inbound seam needs it. It carries no secret material.
 */

const SUBSCRIPTION_REF_PREFIX = "subref_";

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

/**
 * Encode a provider-internal subscription id into a neutral, opaque
 * `subscriptionRef`. Returns `null` for empty/blank input so callers can omit
 * the optional field entirely.
 */
export function toSubscriptionRef(internalSubscriptionId: string | null | undefined): string | null {
  const trimmed = internalSubscriptionId?.trim();
  if (!trimmed) {
    return null;
  }
  return `${SUBSCRIPTION_REF_PREFIX}${toBase64Url(trimmed)}`;
}

/**
 * Decode a neutral `subscriptionRef` back into the provider-internal
 * subscription id. Returns `null` if the ref is missing or malformed.
 */
export function fromSubscriptionRef(subscriptionRef: string | null | undefined): string | null {
  const trimmed = subscriptionRef?.trim();
  if (!trimmed?.startsWith(SUBSCRIPTION_REF_PREFIX)) {
    return null;
  }
  const encoded = trimmed.slice(SUBSCRIPTION_REF_PREFIX.length);
  if (!encoded) {
    return null;
  }
  try {
    const decoded = fromBase64Url(encoded);
    return decoded || null;
  } catch {
    return null;
  }
}
