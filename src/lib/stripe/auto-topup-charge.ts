/**
 * Legacy auto-top-up PaymentIntent metadata helpers.
 *
 * Direct off-session auto-top-up charges are retired (OM invoice trigger +
 * settlement / Stripe app collect instead). Keep metadata parse helpers so
 * in-flight `pymthouse_auto_topup=1` PaymentIntents can still settle via the
 * Stripe webhook drain path and appear in merchant history.
 */
const AUTO_TOP_UP_METADATA_FLAG = "pymthouse_auto_topup";

export function autoTopUpGrantIdempotencyKey(paymentIntentId: string): string {
  return `autotopup:${paymentIntentId.trim()}`;
}

export function isAutoTopUpPaymentIntentMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return String(metadata[AUTO_TOP_UP_METADATA_FLAG] ?? "") === "1";
}

export { AUTO_TOP_UP_METADATA_FLAG };
