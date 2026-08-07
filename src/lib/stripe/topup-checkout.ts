/**
 * Prepaid balance top-up via Stripe Checkout (payment mode) — issues #397/#398.
 *
 * The Builder M2M wallet route creates a payment-mode Checkout Session for a
 * fixed dollar amount; platform webhook settlement (`checkout.session.completed`
 * or `checkout.session.async_payment_succeeded`) credits an OpenMeter/Konnect
 * prepaid grant on the owner wallet, using the Checkout session id as the
 * grant idempotency key so webhook retries can never double-credit.
 */
import { randomUUID } from "node:crypto";

import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import { prepareOwnerCustomerStripeBilling } from "@/lib/openmeter/billing-profiles";
import { ensureOwnerCustomer, listOwnedPublicClientIds } from "@/lib/openmeter/customers";
import { toStripeApiUrl } from "@/lib/openmeter/owner-payment-method";
import {
  getKonnectStripeBillingRefs,
  getStripeCustomerAppDataId,
} from "@/lib/openmeter/stripe-customer-data";

export const TOP_UP_MIN_USD_MICROS = 1_000_000n; // $1.00
export const TOP_UP_MAX_USD_MICROS = 10_000_000_000n; // $10,000.00

const TOP_UP_METADATA_FLAG = "pymthouse_topup";
const CHECKOUT_BUDGET_MS = 15_000;

/**
 * Parse a caller-supplied top-up amount in dollars (string or number, up to
 * 2 decimals) into USD micros within [$1, $10,000].
 */
export function parseTopUpAmountUsd(
  value: unknown,
): { ok: true; amountUsdMicros: bigint } | { ok: false; error: string } {
  let raw: string;
  if (typeof value === "number" && Number.isFinite(value)) {
    raw = String(value);
  } else if (typeof value === "string") {
    raw = value.trim();
  } else {
    return { ok: false, error: "amountUsd is required (e.g. \"25.00\")" };
  }
  const match = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    return {
      ok: false,
      error: "amountUsd must be a positive dollar amount with up to 2 decimals",
    };
  }
  const dollars = BigInt(match[1]);
  const cents = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const amountUsdMicros = dollars * 1_000_000n + cents * 10_000n;
  if (amountUsdMicros < TOP_UP_MIN_USD_MICROS || amountUsdMicros > TOP_UP_MAX_USD_MICROS) {
    return { ok: false, error: "amountUsd must be between $1.00 and $10,000.00" };
  }
  return { ok: true, amountUsdMicros };
}

/** Konnect credit-grant idempotency key for one paid Checkout session. */
export function topUpGrantIdempotencyKey(sessionId: string): string {
  return `topup:${sessionId.trim()}`;
}

/**
 * HTTPS or explicit localhost-development return URL, else the fallback —
 * M2M callers redirect their own dashboards, so same-origin is not required,
 * but plain-http remote targets are rejected.
 */
export function resolveTopUpReturnUrl(
  candidate: string | undefined,
  fallback: string,
): string {
  const raw = candidate?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const isLocalhost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname.endsWith(".localhost");
    if (url.protocol === "https:" || (url.protocol === "http:" && isLocalhost)) {
      return url.toString();
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function stripeSecretKeyOrNull(): string | null {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  return key?.startsWith("sk_") ? key : null;
}

/**
 * Best-effort resolution of the owner wallet's platform Stripe customer so the
 * top-up charge lands on the same customer OpenMeter auto-debits. Returns null
 * (guest checkout) when billing has never been prepared for this owner.
 */
async function resolveOwnerStripeCustomerId(input: {
  ownerUserId: string;
  customerId: string;
  customerKey: string;
}): Promise<string | null> {
  const signal = AbortSignal.timeout(CHECKOUT_BUDGET_MS);
  try {
    await prepareOwnerCustomerStripeBilling({
      client: getHostedAdminClient(),
      customerId: input.customerId,
      customerKey: input.customerKey,
    });
  } catch (err) {
    console.warn("topup-checkout: billing prepare failed", sanitizeForLog(err));
  }
  try {
    const refs = await getKonnectStripeBillingRefs(input.customerId, signal);
    if (refs.stripeCustomerId) {
      return refs.stripeCustomerId;
    }
  } catch (err) {
    console.warn("topup-checkout: Konnect billing read failed", sanitizeForLog(err));
  }
  try {
    return (
      (await getStripeCustomerAppDataId({
        client: getHostedAdminClient(),
        customerId: input.customerId,
        signal,
      })) ?? null
    );
  } catch {
    return null;
  }
}

export type TopUpCheckoutResult = {
  checkoutUrl: string;
  sessionId: string | null;
  amountUsdMicros: string;
};

/**
 * Create a payment-mode Stripe Checkout Session on the platform account that
 * credits the owner's prepaid wallet once paid (settled by the webhook).
 */
export async function createOwnerTopUpCheckoutSession(input: {
  ownerUserId: string;
  /** Public `app_…` client id the M2M caller authenticated as (grant routing). */
  publicClientId: string;
  amountUsdMicros: bigint;
  successUrl?: string;
  cancelUrl?: string;
  /** Optional Stripe Idempotency-Key; generated when omitted. */
  idempotencyKey?: string;
}): Promise<TopUpCheckoutResult> {
  const ownerUserId = input.ownerUserId.trim();
  const publicClientId = input.publicClientId.trim();
  if (!ownerUserId || !publicClientId) {
    throw new Error("ownerUserId and publicClientId are required");
  }
  if (
    input.amountUsdMicros < TOP_UP_MIN_USD_MICROS ||
    input.amountUsdMicros > TOP_UP_MAX_USD_MICROS
  ) {
    throw new Error("amountUsdMicros out of range");
  }
  if (input.amountUsdMicros % 10_000n !== 0n) {
    throw new Error("amountUsdMicros must be a whole-cent amount");
  }
  const apiKey = stripeSecretKeyOrNull();
  if (!apiKey) {
    throw new Error("STRIPE_SECRET_KEY not configured");
  }
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter not configured");
  }

  const client = getHostedAdminClient();
  const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
  const customer = await ensureOwnerCustomer(client, ownerUserId, publicClientIds);
  const stripeCustomerId = await resolveOwnerStripeCustomerId({
    ownerUserId,
    customerId: customer.id,
    customerKey: customer.key,
  });

  const origin = getPublicOrigin();
  const success = resolveTopUpReturnUrl(
    input.successUrl,
    `${origin}/billing?topup=succeeded`,
  );
  const cancel = resolveTopUpReturnUrl(input.cancelUrl, `${origin}/billing`);

  const amountCents = (input.amountUsdMicros / 10_000n).toString();
  const body = new URLSearchParams({
    mode: "payment",
    success_url: success,
    cancel_url: cancel,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": "PymtHouse prepaid credits",
    "line_items[0][price_data][unit_amount]": amountCents,
    "line_items[0][quantity]": "1",
    [`metadata[${TOP_UP_METADATA_FLAG}]`]: "1",
    "metadata[owner_user_id]": ownerUserId,
    "metadata[client_id]": publicClientId,
    "metadata[amount_usd_micros]": input.amountUsdMicros.toString(),
  });
  if (stripeCustomerId) {
    body.set("customer", stripeCustomerId);
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `pymthouse-topup:${ownerUserId}:${publicClientId}:${input.amountUsdMicros}:${randomUUID()}`;
  const response = await fetch(toStripeApiUrl("/v1/checkout/sessions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(CHECKOUT_BUDGET_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    console.error(
      "topup-checkout: Stripe session create failed",
      sanitizeForLog(response.status),
      sanitizeForLog(detail),
    );
    throw new Error("STRIPE_CHECKOUT_CREATE_FAILED");
  }
  const session = (await response.json()) as { id?: string; url?: string };
  if (!session.url) {
    throw new Error("Stripe checkout session URL unavailable");
  }
  return {
    checkoutUrl: session.url,
    sessionId: session.id?.trim() || null,
    amountUsdMicros: input.amountUsdMicros.toString(),
  };
}

export type TopUpCompletedPayload = {
  sessionId: string;
  ownerUserId: string;
  clientId: string;
  amountUsdMicros: bigint;
};

/** Event types that may carry a paid Checkout session for top-up settlement. */
const TOP_UP_SETTLEMENT_EVENT_TYPES = new Set([
  "checkout.session.completed",
  // Delayed methods (bank debit, etc.): completed fires unpaid first; credit here.
  "checkout.session.async_payment_succeeded",
]);

/**
 * Extract a settled top-up from a Checkout session settlement event body
 * (`checkout.session.completed` or `checkout.session.async_payment_succeeded`).
 * Returns null for anything that is not a PAID payment-mode PymtHouse top-up
 * (setup-mode sessions, unpaid async methods on completed, foreign metadata).
 * The amount is taken from Stripe's `amount_total` — metadata is cross-checked
 * and a mismatch rejects the event rather than crediting either number.
 */
export function parseTopUpCheckoutSessionCompleted(
  rawBody: string,
): TopUpCompletedPayload | null {
  const session = paidPaymentSessionFromEvent(rawBody);
  if (!session) {
    return null;
  }
  const sessionId = (session.id as string).trim();
  const metadata =
    session.metadata && typeof session.metadata === "object"
      ? (session.metadata as Record<string, unknown>)
      : {};
  if (metadata[TOP_UP_METADATA_FLAG] !== "1") {
    return null;
  }
  const ownerUserId =
    typeof metadata.owner_user_id === "string" ? metadata.owner_user_id.trim() : "";
  const clientId =
    typeof metadata.client_id === "string" ? metadata.client_id.trim() : "";
  if (!ownerUserId || !clientId) {
    return null;
  }
  const amountUsdMicros = settledAmountUsdMicros(session, metadata, sessionId);
  if (amountUsdMicros === null) {
    return null;
  }
  return { sessionId, ownerUserId, clientId, amountUsdMicros };
}

/**
 * Settlement event body → the session object, only when it is a PAID
 * payment-mode session (`completed` with paid status, or `async_payment_succeeded`).
 */
function paidPaymentSessionFromEvent(rawBody: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const event = parsed as {
    type?: unknown;
    data?: { object?: Record<string, unknown> };
  };
  if (typeof event.type !== "string" || !TOP_UP_SETTLEMENT_EVENT_TYPES.has(event.type)) {
    return null;
  }
  const session = event.data?.object;
  if (!session || typeof session !== "object") {
    return null;
  }
  const sessionId = typeof session.id === "string" ? session.id.trim() : "";
  if (!sessionId.startsWith("cs_")) {
    return null;
  }
  if (session.mode !== "payment" || session.payment_status !== "paid") {
    return null;
  }
  return session;
}

/** Stripe `amount_total` (cents) → USD micros, cross-checked against declared metadata. */
function settledAmountUsdMicros(
  session: Record<string, unknown>,
  metadata: Record<string, unknown>,
  sessionId: string,
): bigint | null {
  const amountTotal = session.amount_total;
  if (typeof amountTotal !== "number" || !Number.isInteger(amountTotal) || amountTotal <= 0) {
    return null;
  }
  if (typeof session.currency !== "string" || session.currency.toLowerCase() !== "usd") {
    return null;
  }
  const amountUsdMicros = BigInt(amountTotal) * 10_000n;
  const declared =
    typeof metadata.amount_usd_micros === "string"
      ? metadata.amount_usd_micros.trim()
      : "";
  if (declared && declared !== amountUsdMicros.toString()) {
    console.warn(
      "topup-checkout: amount mismatch, refusing to credit",
      sanitizeForLog(sessionId),
    );
    return null;
  }
  return amountUsdMicros;
}
