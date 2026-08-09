/**
 * Legacy off-session auto-top-up PaymentIntent helpers.
 *
 * Direct auto-top-up charges are retired (invoice-trigger + settlement / Stripe
 * app collect instead). Keep metadata parse helpers so in-flight
 * `pymthouse_auto_topup=1` PaymentIntents can still settle via the Stripe
 * webhook drain path and appear in merchant history.
 */
const LEGACY_AUTO_TOP_UP_METADATA_FLAG = "pymthouse_auto_topup";

/** Idempotency key prefix is stable so in-flight grants remain deduped. */
export function legacyAutoTopUpGrantIdempotencyKey(
  paymentIntentId: string,
): string {
  return `autotopup:${paymentIntentId.trim()}`;
}

export function isLegacyAutoTopUpPaymentIntentMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return String(metadata[LEGACY_AUTO_TOP_UP_METADATA_FLAG] ?? "") === "1";
}

export { LEGACY_AUTO_TOP_UP_METADATA_FLAG };
