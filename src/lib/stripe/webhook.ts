/**
 * Stripe Connect webhook helpers (signature verify + account.updated parse).
 * No stripe SDK — HMAC over the raw body per Stripe docs.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export { paymentsTabErrorMessage } from "@/lib/stripe/payments-tab-errors";

const DEFAULT_TOLERANCE_SEC = 300;

export type StripeAccountUpdatedPayload = {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

export type StripePaymentMethodAttachedPayload = {
  clientId: string;
  externalUserId: string;
  checkoutSessionId: string | null;
};

function checkoutRestoreMetadata(
  value: unknown,
): StripePaymentMethodAttachedPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const clientId = (metadata as Record<string, unknown>).pymthouse_client_id;
  const externalUserId = (metadata as Record<string, unknown>).external_user_id;
  if (
    typeof clientId !== "string" ||
    !clientId.trim() ||
    typeof externalUserId !== "string" ||
    !externalUserId.trim()
  ) {
    return null;
  }
  const sessionId = (value as { id?: unknown }).id;
  return {
    clientId: clientId.trim(),
    externalUserId: externalUserId.trim(),
    checkoutSessionId:
      typeof sessionId === "string" && sessionId.startsWith("cs_")
        ? sessionId
        : null,
  };
}

/**
 * Extract an app-user restore target from Stripe's durable completion signals.
 * Connect Checkout stamps both session and SetupIntent metadata; platform
 * Checkout is resolved by its persisted Checkout-session id instead.
 */
export function parseStripePaymentMethodAttached(
  rawBody: string,
): StripePaymentMethodAttachedPayload | null {
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
    data?: { object?: unknown };
  };
  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "setup_intent.succeeded"
  ) {
    return null;
  }
  return checkoutRestoreMetadata(event.data?.object);
}

/** Extract the completed Checkout session id for persisted-session lookup. */
export function parseStripeCompletedCheckoutSessionId(
  rawBody: string,
): string | null {
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
    data?: { object?: { id?: unknown } };
  };
  if (event.type !== "checkout.session.completed") {
    return null;
  }
  const sessionId = event.data?.object?.id;
  return typeof sessionId === "string" && sessionId.startsWith("cs_")
    ? sessionId
    : null;
}

export function requireStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret?.startsWith("whsec_")) {
    throw new Error(
      "STRIPE_WEBHOOK_SECRET is required (whsec_… from Stripe Dashboard → Webhooks)",
    );
  }
  return secret;
}

/**
 * Prefer a dedicated Connect endpoint secret; fall back to the platform
 * webhook secret only when `STRIPE_CONNECT_WEBHOOK_SECRET` is unset/empty.
 */
export function resolveConnectWebhookSecret(): string {
  const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  if (!connectSecret) {
    return requireStripeWebhookSecret();
  }
  if (!connectSecret.startsWith("whsec_")) {
    throw new Error(
      "STRIPE_CONNECT_WEBHOOK_SECRET must start with whsec_ when set",
    );
  }
  return connectSecret;
}

/** Which Stripe endpoint a verified signature came from. */
export type StripeWebhookSecretKind = "platform" | "connect";

export type StripeWebhookSecret = {
  secret: string;
  kind: StripeWebhookSecretKind;
};

/**
 * All signing secrets the shared webhook route accepts, deduplicated and
 * tagged by endpoint. The route receives both Connect account events and
 * platform account events (e.g. top-up `checkout.session.completed`), and each
 * Stripe endpoint signs with its own secret — verification must try every
 * configured one, and prepaid credit settlement must additionally require the
 * `platform` kind.
 *
 * Platform is listed first so it wins the identical-secret edge case (one
 * endpoint configured for both roles) rather than settling top-ups as Connect.
 *
 * A malformed secret is skipped when the other is valid, so a bad platform
 * value cannot take down Connect webhooks (and vice versa). Throws only when
 * no usable secret remains.
 */
export function resolveStripeWebhookSecretsByKind(): StripeWebhookSecret[] {
  const platformSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  const resolved: StripeWebhookSecret[] = [];
  if (platformSecret?.startsWith("whsec_")) {
    resolved.push({ secret: platformSecret, kind: "platform" });
  }
  if (connectSecret?.startsWith("whsec_") && connectSecret !== platformSecret) {
    resolved.push({ secret: connectSecret, kind: "connect" });
  }
  if (resolved.length > 0) {
    return resolved;
  }
  if (connectSecret) {
    throw new Error(
      "STRIPE_CONNECT_WEBHOOK_SECRET must start with whsec_ when set",
    );
  }
  if (platformSecret) {
    throw new Error(
      "STRIPE_WEBHOOK_SECRET must start with whsec_ when set",
    );
  }
  throw new Error(
    "STRIPE_WEBHOOK_SECRET is required (whsec_… from Stripe Dashboard → Webhooks)",
  );
}

/** Secrets only, for callers that do not care which endpoint signed. */
export function resolveStripeWebhookSecrets(): string[] {
  return resolveStripeWebhookSecretsByKind().map((entry) => entry.secret);
}

/**
 * Verify Stripe-Signature (t=…,v1=…). Accepts any matching v1 (rotation can
 * send multiple). Returns false on any mismatch / skew.
 */
export function verifyStripeWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
  toleranceSec?: number;
  nowSec?: number;
}): boolean {
  if (!input.signatureHeader?.trim()) {
    return false;
  }
  let timestamp: string | undefined;
  const v1Signatures: string[] = [];
  for (const part of input.signatureHeader.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (k === "t") {
      timestamp = value;
    } else if (k === "v1" && value) {
      v1Signatures.push(value);
    }
  }
  if (!timestamp || v1Signatures.length === 0) {
    return false;
  }
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return false;
  }
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(now - ts) > tolerance) {
    return false;
  }

  const signedPayload = `${timestamp}.${input.rawBody}`;
  const expectedBuf = createHmac("sha256", input.secret)
    .update(signedPayload, "utf8")
    .digest();

  for (const v1 of v1Signatures) {
    let actualBuf: Buffer;
    try {
      actualBuf = Buffer.from(v1, "hex");
    } catch {
      continue;
    }
    if (
      expectedBuf.length === actualBuf.length &&
      timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return true;
    }
  }
  return false;
}

/** Extract Connect capability flags from an account.updated event body. */
export function parseStripeAccountUpdated(
  rawBody: string,
): StripeAccountUpdatedPayload | null {
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
  if (event.type !== "account.updated") {
    return null;
  }
  const obj = event.data?.object;
  if (!obj || typeof obj !== "object") {
    return null;
  }
  const accountId =
    typeof obj.id === "string" ? obj.id.trim() : "";
  if (!accountId.startsWith("acct_")) {
    return null;
  }
  return {
    accountId,
    chargesEnabled: Boolean(obj.charges_enabled),
    payoutsEnabled: Boolean(obj.payouts_enabled),
    detailsSubmitted: Boolean(obj.details_submitted),
  };
}

/**
 * Map OAuth / Connect failures to stable query codes (never raw exception text).
 */
export function merchantConnectOAuthErrorCode(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/Invalid or expired OAuth state/i.test(message)) {
    return "invalid_oauth_state";
  }
  if (/OAuth state expired/i.test(message)) {
    return "oauth_state_expired";
  }
  if (/STRIPE_CONNECT_CLIENT_ID|STRIPE_SECRET_KEY/i.test(message)) {
    return "connect_misconfigured";
  }
  if (/oauth\/token|exchangeConnectOAuthCode|authorization_code/i.test(message)) {
    return "oauth_exchange_failed";
  }
  return "oauth_failed";
}

/**
 * Allowlist Stripe-provided OAuth `error` query values for redirects.
 *
 * Always returns a constant from this fixed map — never the caller-provided
 * string — so user input cannot flow into redirects or control branching
 * (CodeQL js/user-controlled-bypass). A missing/empty provider error maps to
 * "missing_oauth_params".
 */
const STRIPE_OAUTH_PROVIDER_ERROR_CODES: Readonly<Record<string, string>> = {
  "": "missing_oauth_params",
  access_denied: "access_denied",
  invalid_request: "invalid_request",
  invalid_client: "invalid_client",
  invalid_grant: "invalid_grant",
  unauthorized_client: "unauthorized_client",
  unsupported_response_type: "unsupported_response_type",
  invalid_scope: "invalid_scope",
  server_error: "server_error",
  temporarily_unavailable: "temporarily_unavailable",
};

export function sanitizeStripeOAuthProviderError(error: string): string {
  const code = error.trim().toLowerCase();
  return STRIPE_OAUTH_PROVIDER_ERROR_CODES[code] ?? "oauth_denied";
}
