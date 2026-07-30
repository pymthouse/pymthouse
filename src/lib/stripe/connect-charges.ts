/**
 * Off-session PaymentIntent charges on Stripe Connected Accounts (direct charges
 * + application_fee_amount). Falls back to hosted invoice when no default PM.
 */
import {
  applicationFeeAmountCents,
  createConnectedInvoice,
} from "@/lib/stripe/connect-accounts";

function requireStripeSecretKey(): string {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  if (!key?.startsWith("sk_")) {
    throw new Error(
      "STRIPE_SECRET_KEY is required for Connect charges (must be sk_… platform key)",
    );
  }
  return key;
}

function buildOffSessionPaymentIntentBody(input: {
  amountCents: number;
  currency: string;
  customerId: string;
  fee: number;
  description?: string;
  metadata?: Record<string, string>;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("amount", String(input.amountCents));
  body.set("currency", input.currency);
  body.set("customer", input.customerId);
  body.set("confirm", "true");
  body.set("off_session", "true");
  body.set("automatic_payment_methods[enabled]", "true");
  body.set("automatic_payment_methods[allow_redirects]", "never");
  if (input.fee > 0) {
    body.set("application_fee_amount", String(input.fee));
  }
  if (input.description?.trim()) {
    body.set("description", input.description.trim());
  }
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (key.trim() && value.trim()) {
      body.set(`metadata[${key.trim()}]`, value.trim());
    }
  }
  return body;
}

function isMissingPaymentMethodError(err: unknown): boolean {
  const stripeCode =
    err && typeof err === "object" && "stripeCode" in err
      ? String((err as { stripeCode?: string }).stripeCode ?? "")
      : "";
  const message = err instanceof Error ? err.message : String(err);
  return (
    stripeCode === "invoice_no_payment_method_types" ||
    /no.*payment.?method|off_session.*payment_method/i.test(message)
  );
}

async function stripeFormRequest<T>(input: {
  method: string;
  path: string;
  body?: URLSearchParams;
  stripeAccount?: string;
  idempotencyKey?: string;
}): Promise<T> {
  const apiKey = requireStripeSecretKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (input.stripeAccount) {
    headers["Stripe-Account"] = input.stripeAccount;
  }
  if (input.idempotencyKey?.trim()) {
    headers["Idempotency-Key"] = input.idempotencyKey.trim();
  }
  const response = await fetch(`https://api.stripe.com${input.path}`, {
    method: input.method,
    headers,
    body: input.body?.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  let json: T & { error?: { message?: string; code?: string } };
  try {
    json = (await response.json()) as T & {
      error?: { message?: string; code?: string };
    };
  } catch {
    throw new Error(
      `Stripe ${input.method} ${input.path} failed (${response.status}): non-JSON body`,
    );
  }
  if (!response.ok) {
    const err = new Error(
      `Stripe ${input.method} ${input.path} failed (${response.status}): ${
        json.error?.message ?? JSON.stringify(json)
      }`,
    ) as Error & { stripeCode?: string };
    err.stripeCode = json.error?.code;
    throw err;
  }
  return json;
}

export type OffSessionChargeResult =
  | {
      kind: "payment_intent";
      paymentIntentId: string;
      status: string;
      applicationFeeAmount: number;
    }
  | {
      kind: "hosted_invoice";
      invoiceId: string;
      hostedInvoiceUrl: string | null;
      applicationFeeAmount: number;
    };

/**
 * Create + confirm an off-session PaymentIntent on the connected account.
 * Idempotency-Key should be the OpenMeter invoice id.
 *
 * Do NOT treat a successful create as final payment — wait for Stripe webhooks
 * (payment_intent.succeeded / payment_failed / requires_action).
 */
export async function createOffSessionConnectedPaymentIntent(input: {
  accountId: string;
  customerId: string;
  amountCents: number;
  currency?: string;
  applicationFeeBps?: number;
  description?: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}): Promise<OffSessionChargeResult> {
  if (input.amountCents <= 0) {
    throw new Error("amountCents must be a positive integer");
  }
  const currency = (input.currency ?? "usd").toLowerCase();
  const fee = applicationFeeAmountCents({
    amountCents: input.amountCents,
    applicationFeeBps: input.applicationFeeBps ?? 0,
  });

  const body = buildOffSessionPaymentIntentBody({
    amountCents: input.amountCents,
    currency,
    customerId: input.customerId,
    fee,
    description: input.description,
    metadata: input.metadata,
  });

  try {
    const pi = await stripeFormRequest<{
      id?: string;
      status?: string;
    }>({
      method: "POST",
      path: "/v1/payment_intents",
      body,
      stripeAccount: input.accountId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!pi.id?.startsWith("pi_")) {
      throw new Error("Stripe did not return a PaymentIntent id");
    }
    return {
      kind: "payment_intent",
      paymentIntentId: pi.id,
      status: String(pi.status ?? "unknown"),
      applicationFeeAmount: fee,
    };
  } catch (err) {
    if (!isMissingPaymentMethodError(err)) {
      throw err;
    }
    const invoice = await createConnectedInvoice({
      accountId: input.accountId,
      customerId: input.customerId,
      amountCents: input.amountCents,
      currency,
      description: input.description,
      applicationFeeBps: input.applicationFeeBps,
      autoAdvance: true,
      idempotencyKey: `${input.idempotencyKey}:invoice`,
    });
    return {
      kind: "hosted_invoice",
      invoiceId: invoice.invoiceId,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      applicationFeeAmount: fee,
    };
  }
}

/** Retrieve a PaymentIntent on a connected account (sweeper / reconcile). */
export async function retrieveConnectedPaymentIntent(input: {
  accountId: string;
  paymentIntentId: string;
}): Promise<{ id: string; status: string }> {
  const pi = await stripeFormRequest<{ id?: string; status?: string }>({
    method: "GET",
    path: `/v1/payment_intents/${encodeURIComponent(input.paymentIntentId)}`,
    stripeAccount: input.accountId,
  });
  if (!pi.id) {
    throw new Error("PaymentIntent not found");
  }
  return { id: pi.id, status: String(pi.status ?? "unknown") };
}

export { applicationFeeAmountCents };
