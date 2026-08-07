/**
 * PymtHouse merchant Connect orchestration via Stripe Account Links.
 * OpenMeter Stripe app wiring remains a side effect for Starter until cutover.
 */
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import {
  appBillingConfig,
  appBillingOauthStates,
  appUserStripeCustomers,
} from "@/db/schema";
import {
  getAppBillingConfig,
  upsertAppBillingConfig,
  ensureAppStripeBillingReady,
} from "@/lib/openmeter/billing-profiles";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import {
  connectAccountLinkUrls,
  createAccountOnboardingLink,
  createConnectedCheckoutSession,
  createConnectedCustomer,
  createMerchantConnectedAccount,
  exchangeConnectOAuthCode,
  refreshConnectedAccountStatus,
  type StripeOnboardingMethod,
} from "@/lib/stripe/connect-accounts";

export type MerchantConnectMode = "account_link";

type StripeConnectInvoice = {
  id?: string;
  number?: string | null;
  status?: string | null;
  currency?: string | null;
  total?: number | null;
  customer?: string | null;
  created?: number | null;
  period_start?: number | null;
  period_end?: number | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
};

function stripeSecretKey(): string {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  if (!key?.startsWith("sk_")) {
    throw new Error(
      "STRIPE_SECRET_KEY or STRIPE_API_KEY is required for Stripe Connect",
    );
  }
  return key;
}

function invoiceDate(seconds: number | null | undefined): string | undefined {
  return typeof seconds === "number"
    ? new Date(seconds * 1_000).toISOString()
    : undefined;
}

async function stripeConnectInvoiceRequest<T>(
  accountId: string,
  path: string,
): Promise<T> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: {
      Authorization: `Bearer ${stripeSecretKey()}`,
      "Stripe-Account": accountId,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      `Stripe Connect invoice request failed (${response.status}): ${
        body.error?.message ?? "unknown error"
      }`,
    );
  }
  return body;
}

function mapMerchantInvoice(invoice: StripeConnectInvoice) {
  const id = invoice.id?.trim();
  if (!id) return null;
  return {
    id,
    number: invoice.number?.trim() || undefined,
    status: invoice.status?.trim() || "unknown",
    currency: invoice.currency?.toUpperCase() || "USD",
    totalAmount: ((invoice.total ?? 0) / 100).toFixed(2),
    customerId: invoice.customer?.trim() || undefined,
    issuedAt: invoiceDate(invoice.created),
    periodStart: invoiceDate(invoice.period_start),
    periodEnd: invoiceDate(invoice.period_end),
    externalInvoicingId: id,
    invoiceType: "stripe_connect",
  };
}

/** @internal Exported for unit tests. */
export const __testMerchantConnectInvoices = {
  invoiceDate,
  mapMerchantInvoice,
  stripeConnectInvoiceRequest,
};
/** @internal Exported for unit tests. */
export const __testMapMerchantInvoice = mapMerchantInvoice;

async function persistConnectedAccountFlags(input: {
  clientId: string;
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}): Promise<void> {
  const ready = input.chargesEnabled && input.detailsSubmitted;
  const existing = await getAppBillingConfig(input.clientId);
  // Do not write stripeConnectStatus here — that column is Plane A (OM Stripe
  // app install). Merchant readiness is stripeChargesEnabled + detailsSubmitted.
  await upsertAppBillingConfig(input.clientId, {
    stripeConnectedAccountId: input.accountId,
    stripeChargesEnabled: input.chargesEnabled,
    stripePayoutsEnabled: input.payoutsEnabled,
    stripeDetailsSubmitted: input.detailsSubmitted,
    connectedAt: ready
      ? (existing?.connectedAt ?? new Date().toISOString())
      : (existing?.connectedAt ?? null),
  });
}

async function syncConnectedAccountFlags(
  clientId: string,
  accountId: string,
): Promise<{
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}> {
  const status = await refreshConnectedAccountStatus(accountId);
  await persistConnectedAccountFlags({
    clientId,
    accountId,
    chargesEnabled: status.chargesEnabled,
    payoutsEnabled: status.payoutsEnabled,
    detailsSubmitted: status.detailsSubmitted,
  });
  // Keep invoice supplier columns in sync whenever we refresh Connect flags
  // (return URL, Account Link refresh, GET status). Webhook path uses the
  // same helper — without this, merchant mode sees empty country/name.
  await syncSupplierBestEffort(clientId, accountId);
  return {
    chargesEnabled: status.chargesEnabled,
    payoutsEnabled: status.payoutsEnabled,
    detailsSubmitted: status.detailsSubmitted,
  };
}

async function syncSupplierBestEffort(
  clientId: string,
  accountId: string,
): Promise<void> {
  try {
    const { syncTenantSupplierFromConnect } = await import(
      "@/lib/openmeter/supplier-sync"
    );
    await syncTenantSupplierFromConnect({
      clientId,
      accountId,
    });
  } catch (err) {
    console.warn(
      "supplier sync after Connect flag refresh failed",
      sanitizeForLog(clientId),
      sanitizeForLog(err),
    );
  }
}

/**
 * Apply Connect capability flags from a verified `account.updated` webhook.
 * No-ops (returns updated:false) when the acct_ is not linked to an app.
 */
export async function applyConnectedAccountWebhookUpdate(input: {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}): Promise<{ updated: boolean; clientId?: string }> {
  const rows = await db
    .select({ clientId: appBillingConfig.clientId })
    .from(appBillingConfig)
    .where(eq(appBillingConfig.stripeConnectedAccountId, input.accountId))
    .limit(1);
  const clientId = rows[0]?.clientId;
  if (!clientId) {
    return { updated: false };
  }
  await persistConnectedAccountFlags({
    clientId,
    accountId: input.accountId,
    chargesEnabled: input.chargesEnabled,
    payoutsEnabled: input.payoutsEnabled,
    detailsSubmitted: input.detailsSubmitted,
  });
  await syncSupplierBestEffort(clientId, input.accountId);
  return { updated: true, clientId };
}

/** Ensure OM Starter billing profile still exists (platform path). */
async function ensureOmStarterSideEffect(clientId: string): Promise<void> {
  try {
    await ensureAppStripeBillingReady({ clientId });
  } catch {
    // Non-fatal: merchant Connect can proceed without OM Stripe profile.
  }
}

export async function startMerchantConnect({
  clientId,
  email,
  displayName,
}: {
  clientId: string;
  /** Reserved for audit / future session binding; Account Links do not persist OAuth state. */
  userId: string;
  mode?: MerchantConnectMode;
  email?: string;
  displayName?: string;
}): Promise<{ method: "account_link"; url: string; accountId: string }> {
  await ensureOmStarterSideEffect(clientId);

  const existing = await getAppBillingConfig(clientId);
  let accountId = existing?.stripeConnectedAccountId?.trim() || "";
  if (!accountId) {
    accountId = await createMerchantConnectedAccount({
      clientId,
      email,
      displayName,
    });
    await upsertAppBillingConfig(clientId, {
      stripeConnectedAccountId: accountId,
      stripeOnboardingMethod: "account_link" satisfies StripeOnboardingMethod,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      stripeDetailsSubmitted: false,
    });
  }

  const urls = connectAccountLinkUrls(clientId);
  const linkUrl = await createAccountOnboardingLink({
    accountId,
    refreshUrl: urls.refreshUrl,
    returnUrl: urls.returnUrl,
  });
  await syncConnectedAccountFlags(clientId, accountId);
  return { method: "account_link", url: linkUrl, accountId };
}

export async function refreshMerchantAccountLink(clientId: string): Promise<{
  url: string;
  accountId: string;
}> {
  const config = await getAppBillingConfig(clientId);
  const accountId = config?.stripeConnectedAccountId?.trim();
  if (!config || !accountId) {
    throw new Error("No Connected Account yet — start onboarding first");
  }
  if (config.stripeOnboardingMethod === "oauth" && config.stripeChargesEnabled) {
    throw new Error("OAuth-linked accounts do not use Account Links");
  }
  const urls = connectAccountLinkUrls(clientId);
  const url = await createAccountOnboardingLink({
    accountId,
    refreshUrl: urls.refreshUrl,
    returnUrl: urls.returnUrl,
  });
  await syncConnectedAccountFlags(clientId, accountId);
  return { url, accountId };
}

export async function completeMerchantConnectOAuth(input: {
  clientId: string;
  state: string;
  code: string;
}): Promise<void> {
  const rows = await db
    .delete(appBillingOauthStates)
    .where(
      and(
        eq(appBillingOauthStates.state, input.state),
        eq(appBillingOauthStates.clientId, input.clientId),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("Invalid or expired OAuth state");
  }
  if (row.expiresAt < new Date().toISOString()) {
    throw new Error("OAuth state expired");
  }

  const accountId = await exchangeConnectOAuthCode(input.code);
  await upsertAppBillingConfig(input.clientId, {
    stripeConnectedAccountId: accountId,
    stripeOnboardingMethod: "oauth",
  });
  await syncConnectedAccountFlags(input.clientId, accountId);
  await ensureOmStarterSideEffect(input.clientId);
}

export async function syncMerchantConnectStatus(clientId: string): Promise<void> {
  const config = await getAppBillingConfig(clientId);
  const accountId = config?.stripeConnectedAccountId?.trim();
  if (!accountId) {
    return;
  }
  await syncConnectedAccountFlags(clientId, accountId);
}

export function isMerchantConnectPaymentsReady(
  config: typeof appBillingConfig.$inferSelect | null | undefined,
): boolean {
  return Boolean(
    config?.stripeConnectedAccountId?.trim() &&
      config.stripeChargesEnabled &&
      config.stripeDetailsSubmitted,
  );
}

export function connectPaymentsOnlyEnabled(
  config: typeof appBillingConfig.$inferSelect | null | undefined,
): boolean {
  if (process.env.STRIPE_CONNECT_PAYMENTS_ONLY?.trim() === "1") {
    return true;
  }
  return Boolean(config?.connectPaymentsOnly);
}

export async function upsertAppUserStripeCustomer(input: {
  clientId: string;
  externalUserId: string;
  stripeConnectedAccountId: string;
  stripeCustomerId: string;
  openmeterCustomerId?: string | null;
  openmeterCustomerKey?: string | null;
}): Promise<void> {
  const existing = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, input.clientId),
        eq(appUserStripeCustomers.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);
  const now = new Date().toISOString();
  if (existing[0]) {
    await db
      .update(appUserStripeCustomers)
      .set({
        stripeConnectedAccountId: input.stripeConnectedAccountId,
        stripeCustomerId: input.stripeCustomerId,
        openmeterCustomerId: input.openmeterCustomerId ?? null,
        openmeterCustomerKey: input.openmeterCustomerKey ?? null,
        updatedAt: now,
      })
      .where(eq(appUserStripeCustomers.id, existing[0].id));
    return;
  }
  await db.insert(appUserStripeCustomers).values({
    id: uuidv4(),
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: input.stripeConnectedAccountId,
    stripeCustomerId: input.stripeCustomerId,
    openmeterCustomerId: input.openmeterCustomerId ?? null,
    openmeterCustomerKey: input.openmeterCustomerKey ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function getAppUserStripeCustomer(input: {
  clientId: string;
  externalUserId: string;
}): Promise<typeof appUserStripeCustomers.$inferSelect | null> {
  const rows = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, input.clientId),
        eq(appUserStripeCustomers.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

const STRIPE_INVOICE_PAGE_LIMIT = 100;
/** Cap Stripe pagination so a pathological customer cannot loop forever. */
const MAX_MERCHANT_INVOICE_PAGES = 50;

async function listAllMerchantConnectInvoices(
  accountId: string,
  stripeCustomerId: string,
): Promise<StripeConnectInvoice[]> {
  const invoices: StripeConnectInvoice[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_MERCHANT_INVOICE_PAGES; page++) {
    const params = new URLSearchParams({
      customer: stripeCustomerId,
      limit: String(STRIPE_INVOICE_PAGE_LIMIT),
    });
    if (startingAfter) {
      params.set("starting_after", startingAfter);
    }
    const result = await stripeConnectInvoiceRequest<{
      data?: StripeConnectInvoice[];
      has_more?: boolean;
    }>(accountId, `/v1/invoices?${params.toString()}`);
    const batch = result.data ?? [];
    invoices.push(...batch);
    if (!result.has_more || batch.length === 0) {
      break;
    }
    const lastId = batch[batch.length - 1]?.id?.trim();
    if (!lastId) {
      break;
    }
    startingAfter = lastId;
  }
  return invoices;
}

/**
 * List invoices from the merchant's Connected Account for one app user.
 * Merchant billing never reads OpenMeter owner-rollup invoices.
 */
export async function listMerchantConnectInvoicesForAppUser(input: {
  clientId: string;
  externalUserId: string;
  page: number;
  pageSize: number;
}): Promise<{
  items: ReturnType<typeof mapMerchantInvoice>[];
  page: number;
  pageSize: number;
  totalCount: number;
}> {
  const config = await getAppBillingConfig(input.clientId);
  if (!isMerchantConnectPaymentsReady(config)) {
    return { items: [], page: input.page, pageSize: input.pageSize, totalCount: 0 };
  }
  const accountId = config?.stripeConnectedAccountId?.trim();
  const customer = await getAppUserStripeCustomer(input);
  if (
    !accountId ||
    customer?.stripeConnectedAccountId !== accountId ||
    !customer.stripeCustomerId?.trim()
  ) {
    return { items: [], page: input.page, pageSize: input.pageSize, totalCount: 0 };
  }
  const offset = (input.page - 1) * input.pageSize;
  const invoices = (await listAllMerchantConnectInvoices(
    accountId,
    customer.stripeCustomerId,
  ))
    .map((invoice) => mapMerchantInvoice(invoice))
    .filter((invoice): invoice is NonNullable<typeof invoice> => invoice !== null);
  return {
    items: invoices.slice(offset, offset + input.pageSize),
    page: input.page,
    pageSize: input.pageSize,
    totalCount: invoices.length,
  };
}

/** Resolve hosted invoice links only after proving the invoice belongs to the user. */
export async function getMerchantConnectInvoiceLinksForAppUser(input: {
  clientId: string;
  externalUserId: string;
  invoiceId: string;
}): Promise<{ hostedInvoiceUrl: string | null; invoicePdf: string | null } | null> {
  const config = await getAppBillingConfig(input.clientId);
  if (!isMerchantConnectPaymentsReady(config)) {
    return null;
  }
  const accountId = config?.stripeConnectedAccountId?.trim();
  const customer = await getAppUserStripeCustomer(input);
  const invoiceId = input.invoiceId.trim();
  if (
    !accountId ||
    customer?.stripeConnectedAccountId !== accountId ||
    !customer.stripeCustomerId?.trim() ||
    !invoiceId
  ) {
    return null;
  }
  const invoice = await stripeConnectInvoiceRequest<StripeConnectInvoice>(
    accountId,
    `/v1/invoices/${encodeURIComponent(invoiceId)}`,
  );
  if (invoice.customer !== customer.stripeCustomerId) {
    return null;
  }
  return {
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdf: invoice.invoice_pdf ?? null,
  };
}

export async function ensureMerchantOwnedStripeCustomer(input: {
  clientId: string;
  externalUserId: string;
  accountId: string;
  name?: string;
  openmeterCustomerId?: string;
  openmeterCustomerKey?: string;
}): Promise<string> {
  const existing = await getAppUserStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  if (
    existing?.stripeCustomerId &&
    existing.stripeConnectedAccountId === input.accountId
  ) {
    return existing.stripeCustomerId;
  }
  const stripeCustomerId = await createConnectedCustomer({
    accountId: input.accountId,
    name: input.name ?? input.externalUserId,
    metadata: {
      pymthouse_client_id: input.clientId,
      external_user_id: input.externalUserId,
      ...(input.openmeterCustomerId
        ? { openmeter_customer_id: input.openmeterCustomerId }
        : {}),
      ...(input.openmeterCustomerKey
        ? { customer_key: input.openmeterCustomerKey }
        : {}),
    },
  });
  await upsertAppUserStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: input.accountId,
    stripeCustomerId,
    openmeterCustomerId: input.openmeterCustomerId,
    openmeterCustomerKey: input.openmeterCustomerKey,
  });
  return stripeCustomerId;
}

export async function createMerchantConnectCheckoutForUser(input: {
  clientId: string;
  externalUserId: string;
  successUrl: string;
  cancelUrl: string;
  openmeterCustomerId?: string;
  openmeterCustomerKey?: string;
}): Promise<{ checkoutUrl: string; sessionId: string }> {
  const config = await getAppBillingConfig(input.clientId);
  if (!isMerchantConnectPaymentsReady(config)) {
    throw new Error("Merchant Stripe Connect is not ready to accept payments");
  }
  const accountId = config!.stripeConnectedAccountId!;
  const customerId = await ensureMerchantOwnedStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    accountId,
    openmeterCustomerId: input.openmeterCustomerId,
    openmeterCustomerKey: input.openmeterCustomerKey,
  });
  const session = await createConnectedCheckoutSession({
    accountId,
    customerId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    mode: "setup",
    applicationFeeBps: config!.applicationFeeBps ?? 0,
    metadata: {
      pymthouse_client_id: input.clientId,
      external_user_id: input.externalUserId,
    },
  });
  return { checkoutUrl: session.url, sessionId: session.sessionId };
}
