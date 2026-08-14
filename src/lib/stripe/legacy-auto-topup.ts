/**
 * Off-session auto-top-up PaymentIntent helpers.
 *
 * Metadata flag + grant idempotency key are shared by the sync charge path
 * and the Stripe `payment_intent.succeeded` webhook so retries credit once.
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
  const flag = metadata[LEGACY_AUTO_TOP_UP_METADATA_FLAG];
  return typeof flag === "string" && flag === "1";
}

export { LEGACY_AUTO_TOP_UP_METADATA_FLAG };
