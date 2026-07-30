/**
 * Merchant Custom Invoicing state machine.
 *
 * OpenMeter notifications drive when to act; Stripe Connect webhooks are the
 * source of truth for payment outcomes reported back via payment/status.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import {
  appBillingConfig,
  appUserStripeCustomers,
  developerApps,
  oidcClients,
} from "@/db/schema";
import {
  getMerchantInvoiceByOmId,
  getMerchantInvoiceByPaymentIntent,
  upsertMerchantInvoice,
} from "@/lib/invoicing/ledger";
import {
  submitDraftSynchronized,
  submitIssuingSynchronized,
  updateCustomInvoicingPaymentStatus,
  type CustomInvoicingPaymentTrigger,
} from "@/lib/openmeter/custom-invoicing";
import { parseOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import { ceilUsdMicrosToCents } from "@/lib/format-usd-micros";
import {
  createOffSessionConnectedPaymentIntent,
  retrieveConnectedPaymentIntent,
} from "@/lib/stripe/connect-charges";

const ENABLE_DRAFT_HOOK =
  process.env.OPENMETER_CUSTOM_INVOICING_DRAFT_HOOK === "1";
const ENABLE_ISSUING_HOOK =
  process.env.OPENMETER_CUSTOM_INVOICING_ISSUING_HOOK === "1";

type OmInvoicePayload = {
  id?: string;
  status?: string;
  statusDetails?: { extendedStatus?: string };
  currency?: string;
  totals?: { total?: string | number };
  customer?: { id?: string; key?: string };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function extractOmInvoice(payload: unknown): OmInvoicePayload | null {
  const root = asRecord(payload);
  if (!root) {
    return null;
  }
  // Notification may nest the invoice under data / invoice / subject.
  const candidates = [
    root,
    asRecord(root.data),
    asRecord(asRecord(root.data)?.object),
    asRecord(root.invoice),
    asRecord(root.subject),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const id =
      (typeof candidate.id === "string" && candidate.id) ||
      (typeof candidate.invoiceId === "string" && candidate.invoiceId) ||
      "";
    if (id && /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/i.test(id)) {
      return candidate as OmInvoicePayload;
    }
    const nested = asRecord(candidate.invoice);
    if (nested && typeof nested.id === "string") {
      return nested as OmInvoicePayload;
    }
  }
  return null;
}

function extendedStatus(invoice: OmInvoicePayload): string {
  return (
    invoice.statusDetails?.extendedStatus ||
    String(invoice.status ?? "")
  ).toLowerCase();
}

function totalUsdMicros(invoice: OmInvoicePayload): string | null {
  const total = invoice.totals?.total;
  if (total == null) return null;
  // OM totals are typically decimal currency strings (e.g. "12.34").
  const asNumber = Number(total);
  if (!Number.isFinite(asNumber)) return null;
  return String(Math.round(asNumber * 1_000_000));
}

async function resolveAppIdFromCustomerKey(
  customerKey: string | undefined,
): Promise<string | null> {
  if (!customerKey) return null;
  const parsed = parseOpenMeterCustomerKey(customerKey);
  if (!parsed) return null;
  // customer key uses public OIDC client id (app_…)
  const rows = await db
    .select({ appId: developerApps.id })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, parsed.clientId))
    .limit(1);
  return rows[0]?.appId ?? null;
}

async function resolveMerchantBilling(appId: string) {
  const rows = await db
    .select()
    .from(appBillingConfig)
    .where(eq(appBillingConfig.clientId, appId))
    .limit(1);
  return rows[0] ?? null;
}

async function resolveStripeCustomer(input: {
  appId: string;
  openmeterCustomerId?: string | null;
  customerKey?: string | null;
}): Promise<{
  stripeCustomerId: string;
  stripeConnectedAccountId: string;
} | null> {
  if (input.openmeterCustomerId) {
    const byOm = await db
      .select()
      .from(appUserStripeCustomers)
      .where(
        and(
          eq(appUserStripeCustomers.clientId, input.appId),
          eq(appUserStripeCustomers.openmeterCustomerId, input.openmeterCustomerId),
        ),
      )
      .limit(1);
    if (byOm[0]) {
      return {
        stripeCustomerId: byOm[0].stripeCustomerId,
        stripeConnectedAccountId: byOm[0].stripeConnectedAccountId,
      };
    }
  }
  const parsed = input.customerKey
    ? parseOpenMeterCustomerKey(input.customerKey)
    : null;
  if (parsed) {
    const byExt = await db
      .select()
      .from(appUserStripeCustomers)
      .where(
        and(
          eq(appUserStripeCustomers.clientId, input.appId),
          eq(appUserStripeCustomers.externalUserId, parsed.externalUserId),
        ),
      )
      .limit(1);
    if (byExt[0]) {
      return {
        stripeCustomerId: byExt[0].stripeCustomerId,
        stripeConnectedAccountId: byExt[0].stripeConnectedAccountId,
      };
    }
  }
  return null;
}

async function handleDraftSync(invoice: OmInvoicePayload): Promise<void> {
  if (!ENABLE_DRAFT_HOOK || !invoice.id) return;
  await submitDraftSynchronized(invoice.id, {});
}

async function handleIssuingSync(
  invoice: OmInvoicePayload,
  paymentExternalId?: string,
): Promise<void> {
  if (!ENABLE_ISSUING_HOOK || !invoice.id) return;
  await submitIssuingSynchronized(invoice.id, {
    payment: paymentExternalId ? { externalId: paymentExternalId } : undefined,
  });
}

async function initiateCharge(invoice: OmInvoicePayload): Promise<void> {
  if (!invoice.id) {
    throw new Error("OpenMeter invoice missing id");
  }
  const customerKey = invoice.customer?.key;
  const appId = await resolveAppIdFromCustomerKey(customerKey);
  if (!appId) {
    throw new Error(
      `Cannot resolve merchant app from customer key=${customerKey ?? "missing"}`,
    );
  }

  const billing = await resolveMerchantBilling(appId);
  if (!billing?.stripeConnectedAccountId || !billing.stripeChargesEnabled) {
    throw new Error(`Merchant Connect not ready for app ${appId}`);
  }
  if (billing.billingMode !== "merchant") {
    // Plane A invoices must not enter this worker path.
    throw new Error(`App ${appId} billingMode=${billing.billingMode}, expected merchant`);
  }

  const stripeCustomer = await resolveStripeCustomer({
    appId,
    openmeterCustomerId: invoice.customer?.id,
    customerKey,
  });
  if (!stripeCustomer) {
    throw new Error(
      `No Stripe customer mapping for OM customer ${invoice.customer?.id ?? customerKey}`,
    );
  }

  const micros = totalUsdMicros(invoice);
  const amountCents = micros
    ? Number.parseInt(ceilUsdMicrosToCents(micros), 10)
    : 0;
  if (!Number.isFinite(amountCents) || amountCents < 0) {
    throw new Error(`Invalid amount from invoice totals: ${micros}`);
  }
  if (amountCents <= 0) {
    await updateCustomInvoicingPaymentStatus(invoice.id, { trigger: "paid" });
    await upsertMerchantInvoice({
      openmeterInvoiceId: invoice.id,
      appId,
      openmeterCustomerId: invoice.customer?.id,
      stripeConnectedAccountId: stripeCustomer.stripeConnectedAccountId,
      stripeCustomerId: stripeCustomer.stripeCustomerId,
      state: "paid",
      amountUsdMicros: micros,
      currency: String(invoice.currency ?? "USD"),
    });
    return;
  }

  const existing = await getMerchantInvoiceByOmId(invoice.id);
  if (existing?.stripePaymentIntentId) {
    // Already initiated — wait for Stripe webhook.
    return;
  }

  const charge = await createOffSessionConnectedPaymentIntent({
    accountId: stripeCustomer.stripeConnectedAccountId,
    customerId: stripeCustomer.stripeCustomerId,
    amountCents,
    currency: String(invoice.currency ?? "usd"),
    applicationFeeBps: billing.applicationFeeBps,
    description: `OpenMeter invoice ${invoice.id}`,
    idempotencyKey: invoice.id,
    metadata: {
      openmeter_invoice_id: invoice.id,
      pymthouse_app_id: appId,
    },
  });

  if (charge.kind === "payment_intent") {
    await upsertMerchantInvoice({
      openmeterInvoiceId: invoice.id,
      appId,
      openmeterCustomerId: invoice.customer?.id,
      stripeConnectedAccountId: stripeCustomer.stripeConnectedAccountId,
      stripeCustomerId: stripeCustomer.stripeCustomerId,
      stripePaymentIntentId: charge.paymentIntentId,
      state: "charge_initiated",
      amountUsdMicros: micros,
      currency: String(invoice.currency ?? "USD"),
      applicationFeeAmount: charge.applicationFeeAmount,
    });
    await handleIssuingSync(invoice, charge.paymentIntentId);
    // If Stripe returned succeeded synchronously (rare for off_session), still
    // wait for webhook as source of truth — except requires_action needs report.
    if (charge.status === "requires_action") {
      await updateCustomInvoicingPaymentStatus(invoice.id, {
        trigger: "action_required",
      });
    }
    return;
  }

  await upsertMerchantInvoice({
    openmeterInvoiceId: invoice.id,
    appId,
    openmeterCustomerId: invoice.customer?.id,
    stripeConnectedAccountId: stripeCustomer.stripeConnectedAccountId,
    stripeCustomerId: stripeCustomer.stripeCustomerId,
    stripeInvoiceId: charge.invoiceId,
    state: "hosted_invoice_sent",
    amountUsdMicros: micros,
    currency: String(invoice.currency ?? "USD"),
    applicationFeeAmount: charge.applicationFeeAmount,
  });
  await handleIssuingSync(invoice, charge.invoiceId);
  await updateCustomInvoicingPaymentStatus(invoice.id, {
    trigger: "action_required",
  });
}

export function paymentTriggerFromStripeEvent(
  eventType: string,
): CustomInvoicingPaymentTrigger | null {
  switch (eventType) {
    case "payment_intent.succeeded":
      return "paid";
    case "payment_intent.payment_failed":
      return "payment_failed";
    case "payment_intent.requires_action":
      return "action_required";
    case "charge.dispute.created":
      return "payment_uncollectible";
    default:
      return null;
  }
}

function stripeObjectId(payload: unknown): string | null {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const obj = asRecord(data?.object);
  const id = obj?.id;
  return typeof id === "string" ? id : null;
}

function stripeMetadataOmInvoiceId(payload: unknown): string | null {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const obj = asRecord(data?.object);
  const metadata = asRecord(obj?.metadata);
  const id = metadata?.openmeter_invoice_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

async function handleStripePaymentEvent(input: {
  eventType: string;
  payload: unknown;
}): Promise<void> {
  const trigger = paymentTriggerFromStripeEvent(input.eventType);
  if (!trigger) {
    return;
  }

  const piId = stripeObjectId(input.payload);
  const fromMeta = stripeMetadataOmInvoiceId(input.payload);
  let mapping = piId ? await getMerchantInvoiceByPaymentIntent(piId) : null;
  if (!mapping && fromMeta) {
    mapping = await getMerchantInvoiceByOmId(fromMeta);
  }
  if (!mapping) {
    // Not a merchant Custom Invoicing charge — ignore.
    return;
  }

  await updateCustomInvoicingPaymentStatus(mapping.openmeterInvoiceId, {
    trigger,
  });
  await upsertMerchantInvoice({
    openmeterInvoiceId: mapping.openmeterInvoiceId,
    appId: mapping.appId,
    state: trigger === "paid" ? "paid" : trigger,
    stripePaymentIntentId: piId ?? mapping.stripePaymentIntentId,
  });
}

async function handleOpenMeterEvent(input: {
  eventType: string;
  payload: unknown;
}): Promise<void> {
  const invoice = extractOmInvoice(input.payload);
  if (!invoice?.id) {
    // Non-invoice notification (e.g. entitlement) — ignore for this worker.
    return;
  }

  const status = extendedStatus(invoice);
  const customerKey = invoice.customer?.key;
  const appId = await resolveAppIdFromCustomerKey(customerKey);

  if (appId) {
    await upsertMerchantInvoice({
      openmeterInvoiceId: invoice.id,
      appId,
      openmeterCustomerId: invoice.customer?.id,
      state: status || input.eventType,
      amountUsdMicros: totalUsdMicros(invoice),
      currency: String(invoice.currency ?? "USD"),
    });
  }

  if (status.includes("draft") && status.includes("sync")) {
    await handleDraftSync(invoice);
    return;
  }
  if (status.includes("issuing") && status.includes("sync")) {
    const existing = await getMerchantInvoiceByOmId(invoice.id);
    await handleIssuingSync(
      invoice,
      existing?.stripePaymentIntentId ?? existing?.stripeInvoiceId ?? undefined,
    );
    return;
  }
  if (
    status === "payment_processing.pending" ||
    status === "payment_processing" ||
    (status.includes("payment") && status.includes("pending"))
  ) {
    await initiateCharge(invoice);
  }
}

export async function processInvoiceEvent(input: {
  source: string;
  eventType: string;
  payload: unknown;
}): Promise<void> {
  if (input.source === "openmeter") {
    await handleOpenMeterEvent(input);
    return;
  }
  if (input.source === "stripe") {
    if (input.eventType === "account.application.deauthorized") {
      // Ledger-only audit for now; readiness cleared via account.updated elsewhere.
      return;
    }
    await handleStripePaymentEvent(input);
    return;
  }
  throw new Error(`Unknown invoice event source: ${input.source}`);
}

/** Re-poll Stripe for a stuck charge and report status to OpenMeter. */
export async function reconcileMerchantInvoice(
  openmeterInvoiceId: string,
): Promise<void> {
  const mapping = await getMerchantInvoiceByOmId(openmeterInvoiceId);
  if (!mapping?.stripePaymentIntentId || !mapping.stripeConnectedAccountId) {
    return;
  }
  const pi = await retrieveConnectedPaymentIntent({
    accountId: mapping.stripeConnectedAccountId,
    paymentIntentId: mapping.stripePaymentIntentId,
  });
  let trigger: CustomInvoicingPaymentTrigger | null = null;
  if (pi.status === "succeeded") trigger = "paid";
  else if (pi.status === "requires_action") trigger = "action_required";
  else if (pi.status === "canceled") trigger = "payment_failed";
  else if (pi.status === "requires_payment_method") trigger = "payment_failed";
  if (!trigger) return;

  await updateCustomInvoicingPaymentStatus(mapping.openmeterInvoiceId, {
    trigger,
  });
  await upsertMerchantInvoice({
    openmeterInvoiceId: mapping.openmeterInvoiceId,
    appId: mapping.appId,
    state: trigger === "paid" ? "paid" : trigger,
  });
}
