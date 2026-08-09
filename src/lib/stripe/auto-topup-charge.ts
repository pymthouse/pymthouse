/**
 * Off-session Stripe PaymentIntent for per-user auto top-up.
 */
import { toStripeApiUrl } from "@/lib/openmeter/owner-payment-method";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

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

function stripeSecretKeyOrNull(): string | null {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  if (!key?.startsWith("sk_")) {
    return null;
  }
  return key;
}

/** USD micros → Stripe integer cents (floor toward zero). */
export function usdMicrosToStripeCents(amountUsdMicros: bigint): number {
  if (amountUsdMicros <= 0n) {
    throw new Error("auto top-up amount must be positive");
  }
  const cents = amountUsdMicros / 10_000n;
  if (cents < 50n) {
    throw new Error("auto top-up amount must be at least $0.50");
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("auto top-up amount too large");
  }
  return Number(cents);
}

export type OffSessionAutoTopUpResult =
  | { ok: true; paymentIntentId: string; status: string }
  | { ok: false; error: string; status?: string };

/**
 * Confirm an off-session PaymentIntent on the platform or Connected Account.
 */
export async function createOffSessionAutoTopUpPaymentIntent(input: {
  stripeCustomerId: string;
  paymentMethodId: string;
  amountUsdMicros: bigint;
  clientId: string;
  externalUserId: string;
  /**
   * ISO currency from `app_billing_config.default_currency` (Stripe lowercase).
   * Defaults to `usd` — must match webhook settlement checks.
   */
  currency?: string | null;
  /** Connect account id when charging a merchant end-user. */
  stripeAccount?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<OffSessionAutoTopUpResult> {
  const apiKey = stripeSecretKeyOrNull();
  if (!apiKey) {
    return { ok: false, error: "stripe_unconfigured" };
  }

  let amountCents: number;
  try {
    amountCents = usdMicrosToStripeCents(input.amountUsdMicros);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "invalid_amount",
    };
  }

  const currency =
    (typeof input.currency === "string" && input.currency.trim()
      ? input.currency.trim().toLowerCase()
      : null) || "usd";

  const body = new URLSearchParams();
  body.set("amount", String(amountCents));
  body.set("currency", currency);
  body.set("customer", input.stripeCustomerId.trim());
  body.set("payment_method", input.paymentMethodId.trim());
  body.set("off_session", "true");
  body.set("confirm", "true");
  body.set(`metadata[${AUTO_TOP_UP_METADATA_FLAG}]`, "1");
  body.set("metadata[client_id]", input.clientId.trim());
  body.set("metadata[external_user_id]", input.externalUserId.trim());

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const account = input.stripeAccount?.trim();
  if (account) {
    headers["Stripe-Account"] = account;
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(toStripeApiUrl("/v1/payment_intents"), {
      method: "POST",
      headers,
      body,
      signal: input.signal,
    });
  } catch (err) {
    console.warn(
      "[auto-topup] PaymentIntent request failed",
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return { ok: false, error: "stripe_request_failed" };
  }

  const json = (await response.json().catch(() => null)) as {
    id?: string;
    status?: string;
    error?: { message?: string; code?: string };
  } | null;

  if (!response.ok) {
    const message =
      json?.error?.message?.trim() ||
      `stripe_http_${response.status}`;
    return {
      ok: false,
      error: message,
      status: json?.status,
    };
  }

  const paymentIntentId = json?.id?.trim();
  const status = json?.status?.trim() || "unknown";
  if (!paymentIntentId) {
    return { ok: false, error: "missing_payment_intent_id", status };
  }
  if (status !== "succeeded") {
    return {
      ok: false,
      error: `payment_intent_${status}`,
      status,
      // Include id so webhook can still settle if it later succeeds.
    };
  }
  return { ok: true, paymentIntentId, status };
}

export { AUTO_TOP_UP_METADATA_FLAG };
