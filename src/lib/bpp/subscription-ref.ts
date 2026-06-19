/**
 * Neutral, provider-OPAQUE `subscriptionRef` for the BPP ② `validate` seam.
 *
 * Background: PR #133 made `validate` OpenMeter-authoritative and (incorrectly)
 * returned the raw `openmeter_subscription_id` — a provider-internal identifier
 * leaking across the BPP boundary. Per the C0 `validate.schema.json`, providers
 * may surface an OPTIONAL `subscriptionRef`: a neutral opaque pointer whose
 * meaning is decided by the provider and which MUST NOT encode a
 * provider-internal identifier name.
 *
 * Design (audit C-2 — true opacity):
 *  - The field name (`subscriptionRef`) is provider-neutral.
 *  - The VALUE is a one-way, keyed token — `subref_` +
 *    base64url(HMAC_SHA256(secret, "context\0" + internalId)) — truncated to a
 *    sane length. It is **opaque, NOT reversible**: a client cannot derive the
 *    raw OpenMeter id from the ref (no key, and HMAC is one-way even with the
 *    key). This replaces the previous base64url encoding, which was trivially
 *    reversible by anyone.
 *  - It is deterministic/stable: the same internal id always maps to the same
 *    ref (good for correlation / idempotency).
 *  - Resolution where pymthouse legitimately needs it: pymthouse owns the
 *    subscription store, so it resolves a presented ref by **verifying** it
 *    against candidate internal ids it already holds, via
 *    {@link subscriptionRefMatches} (constant-time). Blind `ref → id` reversal
 *    is intentionally NOT possible. If a future inbound seam ever needs O(1)
 *    blind resolution, add a minimal expand-only lookup table populated at mint
 *    time — no schema change is required today.
 *
 * Key material: `SUBSCRIPTION_REF_SECRET` (preferred). When unset/too short it
 * falls back to `AUTH_TOKEN_PEPPER` (already required on every `validate` path)
 * with a one-time warning, so existing deployments keep working without new env.
 * Domain separation (`HMAC_CONTEXT`) keeps these digests disjoint from the
 * token-hashing use of the same pepper.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const SUBSCRIPTION_REF_PREFIX = "subref_";
/** Domain-separation label so the digest can never collide with other HMAC uses of the key. */
const HMAC_CONTEXT = "bpp:subscription-ref:v1";
/** base64url chars of the digest to keep (~192 bits — ample collision resistance). */
const REF_TOKEN_LENGTH = 32;
const MIN_SECRET_LENGTH = 32;

let warnedAboutSecretFallback = false;

function warnOnce(event: string, reason: string): void {
  if (warnedAboutSecretFallback) {
    return;
  }
  warnedAboutSecretFallback = true;
  console.warn(JSON.stringify({ level: "warn", event, reason }));
}

/**
 * Resolve the HMAC key for the opaque ref. Prefers `SUBSCRIPTION_REF_SECRET`;
 * falls back to the (always-present on validate) `AUTH_TOKEN_PEPPER` with a
 * one-time warning. Throws only when neither high-entropy secret is available —
 * matching the repo's `AUTH_TOKEN_PEPPER` "fail-closed" convention.
 */
function loadSubscriptionRefSecret(): string {
  const dedicated = process.env.SUBSCRIPTION_REF_SECRET?.trim();
  if (dedicated && dedicated.length >= MIN_SECRET_LENGTH) {
    return dedicated;
  }
  if (dedicated) {
    warnOnce(
      "bpp.subscription_ref.weak_secret",
      `SUBSCRIPTION_REF_SECRET is shorter than ${MIN_SECRET_LENGTH} chars; falling back to AUTH_TOKEN_PEPPER`,
    );
  } else {
    warnOnce(
      "bpp.subscription_ref.secret_fallback",
      "SUBSCRIPTION_REF_SECRET not set; deriving the opaque subscriptionRef key from AUTH_TOKEN_PEPPER",
    );
  }

  const pepper = process.env.AUTH_TOKEN_PEPPER?.trim();
  if (!pepper || pepper.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SUBSCRIPTION_REF_SECRET (or AUTH_TOKEN_PEPPER) is required (min ${MIN_SECRET_LENGTH} chars) ` +
        "to mint an opaque subscriptionRef.",
    );
  }
  return pepper;
}

function computeOpaqueToken(internalId: string): string {
  return createHmac("sha256", loadSubscriptionRefSecret())
    .update(HMAC_CONTEXT)
    .update("\x00")
    .update(internalId)
    .digest("base64url")
    .slice(0, REF_TOKEN_LENGTH);
}

/**
 * Encode a provider-internal subscription id into a neutral, OPAQUE (one-way)
 * `subscriptionRef`. Returns `null` for empty/blank input so callers can omit
 * the optional field entirely. The raw id is NOT recoverable from the result.
 */
export function toSubscriptionRef(
  internalSubscriptionId: string | null | undefined,
): string | null {
  const trimmed = internalSubscriptionId?.trim();
  if (!trimmed) {
    return null;
  }
  return `${SUBSCRIPTION_REF_PREFIX}${computeOpaqueToken(trimmed)}`;
}

/**
 * Verify (constant-time) that an opaque `subscriptionRef` corresponds to a known
 * provider-internal subscription id. This is how pymthouse resolves a presented
 * ref against candidates it already owns, since the ref cannot be reversed.
 * Returns `false` for any missing/blank/mismatched input.
 */
export function subscriptionRefMatches(
  subscriptionRef: string | null | undefined,
  internalSubscriptionId: string | null | undefined,
): boolean {
  const provided = subscriptionRef?.trim();
  const expected = toSubscriptionRef(internalSubscriptionId);
  if (!provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
