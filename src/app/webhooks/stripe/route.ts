import { NextResponse } from "next/server";

import {
  restoreAppUserBillingProfileAfterPaymentMethodAttached,
  restoreAppUserBillingProfileForCheckoutSession,
} from "@/lib/openmeter/app-user-payment-method";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  applyConnectedAccountWebhookUpdate,
  findAppUserStripeCustomerByStripeId,
} from "@/lib/stripe/merchant-connect";
import {
  merchantTopUpAccountMatches,
  topUpClientOwnedByOwner,
} from "@/lib/stripe/topup-ownership";
import {
  autoTopUpGrantIdempotencyKey,
  isAutoTopUpPaymentIntentMetadata,
} from "@/lib/stripe/auto-topup-charge";
import {
  parseTopUpCheckoutSessionCompleted,
  topUpGrantIdempotencyKey,
} from "@/lib/stripe/topup-checkout";
import {
  parseStripeAttachedPaymentMethodId,
  parseStripeCompletedCheckoutSessionId,
  parseStripeAccountUpdated,
  parseStripePaymentMethodAttached,
  parseStripePaymentMethodAttachedCustomer,
  resolveStripeWebhookSecretsByKind,
  verifyStripeWebhookSignature,
  type StripeWebhookSecret,
  type StripeWebhookSecretKind,
} from "@/lib/stripe/webhook";

export const runtime = "nodejs";

const TAG = "[stripe-webhook]";

function logHandlerError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(TAG, `${context} failed:`, sanitizeForLog(message));
}

/** Which configured endpoint secret signed this delivery, if any. */
function verifyWebhookSecretKind(input: {
  secrets: StripeWebhookSecret[];
  rawBody: string;
  signatureHeader: string | null;
}): StripeWebhookSecretKind | null {
  for (const entry of input.secrets) {
    if (
      verifyStripeWebhookSignature({
        rawBody: input.rawBody,
        signatureHeader: input.signatureHeader,
        secret: entry.secret,
      })
    ) {
      return entry.kind;
    }
  }
  return null;
}

function stripeEventAccount(rawBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const account = (parsed as { account?: unknown }).account;
  return typeof account === "string" && account.trim() ? account.trim() : null;
}

/**
 * Metadata alone is not a restore authority. Prefer a server-issued Checkout
 * session mapping; otherwise require the emitting Connect `account` to match
 * the target app's Connected Account (same binding as merchant top-up).
 */
async function handlePaymentMethodRestore(
  rawBody: string,
): Promise<Response | null> {
  const account = stripeEventAccount(rawBody);
  const restoreTarget = parseStripePaymentMethodAttached(rawBody);
  if (restoreTarget) {
    if (restoreTarget.checkoutSessionId) {
      const restored = await restoreAppUserBillingProfileForCheckoutSession(
        restoreTarget.checkoutSessionId,
        restoreTarget.paymentMethodId,
      );
      return NextResponse.json({ received: true, restored });
    }

    if (account) {
      let matches: boolean;
      try {
        matches = await merchantTopUpAccountMatches(
          restoreTarget.clientId,
          account,
        );
      } catch (err) {
        logHandlerError("payment method restore account match", err);
        return NextResponse.json({ error: "handler_failed" }, { status: 500 });
      }
      if (!matches) {
        console.warn(
          TAG,
          "payment method restore ignored: account mismatch",
          sanitizeForLog(restoreTarget.clientId),
          sanitizeForLog(account),
        );
        return NextResponse.json({
          received: true,
          ignored: "connect_account_mismatch",
        });
      }
      await restoreAppUserBillingProfileAfterPaymentMethodAttached(
        restoreTarget,
      );
      return NextResponse.json({
        received: true,
        restored: true,
        clientId: restoreTarget.clientId,
      });
    }

    // Platform event without a Checkout session id: do not trust metadata alone.
    // Fall through to Stripe-customer reverse lookup / persisted session id.
  }

  const byCustomer = parseStripePaymentMethodAttachedCustomer(rawBody);
  if (byCustomer) {
    const row = await findAppUserStripeCustomerByStripeId(
      byCustomer.stripeCustomerId,
    );
    if (row?.clientId && row.externalUserId) {
      if (account) {
        const rowAccount = row.stripeConnectedAccountId?.trim() || "";
        if (!rowAccount || rowAccount !== account) {
          console.warn(
            TAG,
            "payment method restore ignored: customer account mismatch",
            sanitizeForLog(row.clientId),
            sanitizeForLog(account),
          );
          return NextResponse.json({
            received: true,
            ignored: "connect_account_mismatch",
          });
        }
      }
      await restoreAppUserBillingProfileAfterPaymentMethodAttached({
        clientId: row.clientId,
        externalUserId: row.externalUserId,
        paymentMethodId: byCustomer.paymentMethodId,
      });
      return NextResponse.json({
        received: true,
        restored: true,
        clientId: row.clientId,
      });
    }
  }

  const checkoutSessionId = parseStripeCompletedCheckoutSessionId(rawBody);
  if (!checkoutSessionId) {
    return null;
  }
  const restored = await restoreAppUserBillingProfileForCheckoutSession(
    checkoutSessionId,
    parseStripeAttachedPaymentMethodId(rawBody),
  );
  return NextResponse.json({ received: true, restored });
}

async function handleAccountUpdated(rawBody: string): Promise<Response> {
  const account = parseStripeAccountUpdated(rawBody);
  if (!account) {
    return NextResponse.json({ received: true, ignored: "malformed_account" });
  }
  try {
    const result = await applyConnectedAccountWebhookUpdate(account);
    return NextResponse.json({
      received: true,
      updated: result.updated,
      clientId: result.clientId ?? null,
    });
  } catch (err) {
    logHandlerError("account.updated", err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}

async function settleOwnerTopUp(input: {
  rawBody: string;
  secretKind: StripeWebhookSecretKind;
  sessionId: string;
  clientId: string;
  ownerUserId: string;
  amountUsdMicros: bigint;
}): Promise<Response> {
  if (input.secretKind !== "platform") {
    return NextResponse.json({
      received: true,
      ignored: "topup_requires_platform_secret",
    });
  }
  if (stripeEventAccount(input.rawBody)) {
    return NextResponse.json({
      received: true,
      ignored: "connect_account_event",
    });
  }

  let owned: boolean;
  try {
    owned = await topUpClientOwnedByOwner(input.clientId, input.ownerUserId);
  } catch (err) {
    logHandlerError("top-up ownership", err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
  if (!owned) {
    console.warn(
      TAG,
      "top-up ignored: clientId not owned by ownerUserId",
      sanitizeForLog(input.clientId),
      sanitizeForLog(input.ownerUserId),
    );
    return NextResponse.json({
      received: true,
      ignored: "client_not_owned_by_owner",
    });
  }

  try {
    // The Checkout session id is the grant idempotency key — a Stripe retry
    // or duplicate delivery 409s inside Konnect and credits exactly once.
    await grantAllowanceUsdMicros({
      clientId: input.clientId,
      externalUserId: `owner:${input.ownerUserId}`,
      amountUsdMicros: input.amountUsdMicros,
      source: "topup",
      idempotencyKey: topUpGrantIdempotencyKey(input.sessionId),
    });
    return NextResponse.json({
      received: true,
      credited: true,
      sessionId: input.sessionId,
    });
  } catch (err) {
    logHandlerError("top-up settle", err);
    // 500 → Stripe retries; the idempotency key makes the retry safe.
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}

async function settleMerchantTopUp(input: {
  rawBody: string;
  sessionId: string;
  clientId: string;
  externalUserId: string;
  amountUsdMicros: bigint;
}): Promise<Response> {
  const account = stripeEventAccount(input.rawBody);
  if (!account) {
    return NextResponse.json({
      received: true,
      ignored: "merchant_topup_missing_account",
    });
  }

  let matches: boolean;
  try {
    matches = await merchantTopUpAccountMatches(input.clientId, account);
  } catch (err) {
    logHandlerError("merchant top-up account match", err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
  if (!matches) {
    console.warn(
      TAG,
      "merchant top-up ignored: account mismatch",
      sanitizeForLog(input.clientId),
      sanitizeForLog(account),
    );
    return NextResponse.json({
      received: true,
      ignored: "connect_account_mismatch",
    });
  }

  try {
    await grantAllowanceUsdMicros({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      amountUsdMicros: input.amountUsdMicros,
      source: "topup",
      idempotencyKey: topUpGrantIdempotencyKey(input.sessionId),
    });
    return NextResponse.json({
      received: true,
      credited: true,
      sessionId: input.sessionId,
    });
  } catch (err) {
    logHandlerError("merchant top-up settle", err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}

async function handleAutoTopUpPaymentIntentSucceeded(
  rawBody: string,
  secretKind: StripeWebhookSecretKind,
): Promise<Response> {
  let parsed: {
    data?: {
      object?: {
        id?: string;
        amount?: number;
        status?: string;
        metadata?: Record<string, unknown>;
      };
    };
  };
  try {
    parsed = JSON.parse(rawBody) as typeof parsed;
  } catch {
    return NextResponse.json({ received: true, ignored: "malformed" });
  }
  const pi = parsed.data?.object;
  const paymentIntentId = pi?.id?.trim();
  const metadata = pi?.metadata;
  if (
    !paymentIntentId ||
    !isAutoTopUpPaymentIntentMetadata(metadata) ||
    String(pi?.status ?? "") !== "succeeded"
  ) {
    return NextResponse.json({
      received: true,
      ignored: "not_auto_topup",
    });
  }
  const clientId =
    typeof metadata?.client_id === "string" ? metadata.client_id.trim() : "";
  const externalUserId =
    typeof metadata?.external_user_id === "string"
      ? metadata.external_user_id.trim()
      : "";
  const amountCents =
    typeof pi?.amount === "number" && Number.isFinite(pi.amount)
      ? Math.trunc(pi.amount)
      : 0;
  if (!clientId || !externalUserId || amountCents <= 0) {
    return NextResponse.json({
      received: true,
      ignored: "auto_topup_incomplete_metadata",
    });
  }

  // Same tenancy binding as sibling top-up handlers:
  // - Connect events: account must match the target app's Connected Account
  //   (settleMerchantTopUp).
  // - Platform events (no account): platform secret + owner subject must own
  //   client_id (settleOwnerTopUp). Platform auto-topup only charges the owner
  //   wallet — bare external_user_id without Connect account is rejected.
  const account = stripeEventAccount(rawBody);
  if (account) {
    let matches: boolean;
    try {
      matches = await merchantTopUpAccountMatches(clientId, account);
    } catch (err) {
      logHandlerError("auto-topup account match", err);
      return NextResponse.json({ error: "handler_failed" }, { status: 500 });
    }
    if (!matches) {
      console.warn(
        TAG,
        "auto-topup ignored: account mismatch",
        sanitizeForLog(clientId),
        sanitizeForLog(account),
      );
      return NextResponse.json({
        received: true,
        ignored: "connect_account_mismatch",
      });
    }
  } else {
    if (secretKind !== "platform") {
      return NextResponse.json({
        received: true,
        ignored: "auto_topup_requires_platform_secret",
      });
    }
    const ownerPrefix = "owner:";
    if (!externalUserId.startsWith(ownerPrefix)) {
      return NextResponse.json({
        received: true,
        ignored: "auto_topup_platform_requires_owner_subject",
      });
    }
    const ownerUserId = externalUserId.slice(ownerPrefix.length).trim();
    if (!ownerUserId) {
      return NextResponse.json({
        received: true,
        ignored: "auto_topup_incomplete_metadata",
      });
    }
    let owned: boolean;
    try {
      owned = await topUpClientOwnedByOwner(clientId, ownerUserId);
    } catch (err) {
      logHandlerError("auto-topup ownership", err);
      return NextResponse.json({ error: "handler_failed" }, { status: 500 });
    }
    if (!owned) {
      console.warn(
        TAG,
        "auto-topup ignored: clientId not owned by ownerUserId",
        sanitizeForLog(clientId),
        sanitizeForLog(ownerUserId),
      );
      return NextResponse.json({
        received: true,
        ignored: "client_not_owned_by_owner",
      });
    }
  }

  const amountUsdMicros = BigInt(amountCents) * 10_000n;
  try {
    // Idempotent with the sync grant path (same key).
    await grantAllowanceUsdMicros({
      clientId,
      externalUserId,
      amountUsdMicros,
      source: "topup",
      idempotencyKey: autoTopUpGrantIdempotencyKey(paymentIntentId),
    });
    return NextResponse.json({
      received: true,
      credited: true,
      paymentIntentId,
    });
  } catch (err) {
    logHandlerError("auto-topup settle", err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}

async function handleCheckoutSessionCompleted(
  rawBody: string,
  secretKind: StripeWebhookSecretKind,
): Promise<Response> {
  const topUp = parseTopUpCheckoutSessionCompleted(rawBody);
  if (topUp) {
    if (topUp.externalUserId) {
      // Merchant Connect end-user top-up — accept Connect-signed or
      // platform-signed events that carry the Connected Account id.
      return settleMerchantTopUp({
        rawBody,
        sessionId: topUp.sessionId,
        clientId: topUp.clientId,
        externalUserId: topUp.externalUserId,
        amountUsdMicros: topUp.amountUsdMicros,
      });
    }
    if (topUp.ownerUserId) {
      return settleOwnerTopUp({
        rawBody,
        secretKind,
        sessionId: topUp.sessionId,
        clientId: topUp.clientId,
        ownerUserId: topUp.ownerUserId,
        amountUsdMicros: topUp.amountUsdMicros,
      });
    }
  }

  // Setup-mode / subscribe checkouts restore the app-user billing profile.
  try {
    const restored = await handlePaymentMethodRestore(rawBody);
    if (restored) {
      return restored;
    }
  } catch (err) {
    logHandlerError("payment method restore", err);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }

  // Setup-mode sessions, unpaid async payments, foreign metadata.
  return NextResponse.json({ received: true, ignored: "not_a_topup" });
}

function eventTypeFromRawBody(rawBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  const rawType =
    parsed && typeof parsed === "object" && "type" in parsed
      ? (parsed as { type?: unknown }).type
      : undefined;
  return typeof rawType === "string" ? rawType : "";
}

/**
 * Stripe webhook for Connect account lifecycle (KYC / readiness), app-user
 * payment-method restore, platform prepaid top-up settlement, and merchant
 * Connect end-user top-up settlement. Configure in Dashboard → Developers →
 * Webhooks:
 *   POST {PUBLIC_ORIGIN}/webhooks/stripe
 *
 * Subscribe at least to:
 *   account.updated                          (Connect endpoint)
 *   checkout.session.completed               (platform + Connect — top-ups / PM)
 *   checkout.session.async_payment_succeeded (platform + Connect — delayed)
 *   setup_intent.succeeded                   (Connect — app-user payment methods)
 *   payment_method.attached                  (Connect — belt-and-suspenders PM default)
 *   payment_intent.succeeded                 (platform + Connect — auto top-up settle)
 *
 * PaymentIntent / charge / dispute events for Custom Invoicing settlement are
 * handled by pymthouse/settlement (Kafka producer), not this route.
 *
 * Owner top-up grants require the platform webhook secret and a platform
 * (non-Connect) event. Merchant end-user top-ups and Connect auto top-ups
 * require a Connect `account` field matching the app's Connected Account.
 * Platform auto top-ups require the platform secret plus `owner:{userId}`
 * ownership of `client_id`. Payment-method restore from Connect metadata also
 * requires that account match (or a server-issued Checkout session mapping).
 */
export async function POST(request: Request): Promise<Response> {
  let secrets: StripeWebhookSecret[];
  try {
    secrets = resolveStripeWebhookSecretsByKind();
  } catch (err) {
    logHandlerError("configuration", err);
    return NextResponse.json({ error: "webhook_misconfigured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature");
  const secretKind = verifyWebhookSecretKind({
    secrets,
    rawBody,
    signatureHeader,
  });
  if (!secretKind) {
    console.warn(TAG, "signature rejected");
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const type = eventTypeFromRawBody(rawBody);
  if (type === null) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (type === "account.updated") {
    return handleAccountUpdated(rawBody);
  }
  if (
    type === "checkout.session.completed" ||
    type === "checkout.session.async_payment_succeeded"
  ) {
    return handleCheckoutSessionCompleted(rawBody, secretKind);
  }
  if (type === "payment_intent.succeeded") {
    return handleAutoTopUpPaymentIntentSucceeded(rawBody, secretKind);
  }
  if (type === "setup_intent.succeeded" || type === "payment_method.attached") {
    try {
      const restored = await handlePaymentMethodRestore(rawBody);
      if (restored) {
        return restored;
      }
    } catch (err) {
      logHandlerError("payment method restore", err);
      return NextResponse.json({ error: "handler_failed" }, { status: 500 });
    }
  }
  return NextResponse.json({ received: true, ignored: type || "unknown" });
}
