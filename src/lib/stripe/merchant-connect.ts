/**
 * PymtHouse merchant Connect orchestration via Stripe Account Links.
 * OpenMeter Stripe app wiring remains a side effect for Starter until cutover.
 */
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db, type Db } from "@/db/index";
import {
  appBillingConfig,
  appBillingOauthStates,
  appStripeConnectAccounts,
  appUserStripeCustomers,
} from "@/db/schema";
import { formatUsdMicrosForDisplay } from "@/lib/billing/pay-per-use-threshold";
import {
  platformDefaultApplicationFeeBps,
  platformDefaultEndUserCap,
} from "@/lib/billing/platform-billing-defaults";
import { getUnbilledDebtDetails } from "@/lib/billing/unbilled-debt";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  appUserRetailCustomerKey,
  resolveOpenMeterBillingIdentity,
} from "@/lib/openmeter/billing-identity";
import {
  getAppBillingConfig,
  upsertAppBillingConfig,
  ensureAppStripeBillingReady,
} from "@/lib/openmeter/billing-profiles";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import { isLegacyAutoTopUpPaymentIntentMetadata } from "@/lib/stripe/legacy-auto-topup";
import {
  connectAccountLinkUrls,
  createAccountOnboardingLink,
  createConnectedCheckoutSession,
  createConnectedCustomer,
  createMerchantConnectedAccount,
  exchangeConnectOAuthCode,
  refreshConnectedAccountStatus,
  resolveStripePlatformSecretKey,
  type StripeOnboardingMethod,
} from "@/lib/stripe/connect-accounts";

export type MerchantConnectMode = "account_link";

/** Shape of a Stripe PaymentIntent/Invoice decline — same fields either way. */
type StripePaymentError = {
  code?: string | null;
  decline_code?: string | null;
  message?: string | null;
  type?: string | null;
};

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
  /** Set only if finalization itself failed (rare — e.g. tax calculation). */
  last_finalization_error?: StripePaymentError | null;
  /** Expanded (see the `expand[]` param below) so a declined autopay attempt
   * is visible without a second Stripe round-trip per invoice. */
  payment_intent?: string | { last_payment_error?: StripePaymentError | null } | null;
};

type StripeConnectPaymentMethod = {
  id?: string;
  type?: string | null;
  card?: { brand?: string | null } | null;
  link?: { email?: string | null } | null;
};

type StripeConnectPaymentIntent = {
  id?: string;
  amount?: number | null;
  currency?: string | null;
  status?: string | null;
  customer?: string | null;
  created?: number | null;
  /** Set when this PI paid a Stripe Invoice — history should keep the invoice only. */
  invoice?: string | { id?: string | null } | null;
  metadata?: Record<string, unknown> | null;
  payment_method?: string | StripeConnectPaymentMethod | null;
  latest_charge?:
    | string
    | {
        id?: string;
        receipt_url?: string | null;
      }
    | null;
};

/** Unified merchant billing history row (Stripe invoice or auto top-up PI). */
export type MerchantBillingHistoryItem = {
  id: string;
  number?: string;
  status: string;
  currency: string;
  totalAmount: string;
  customerId?: string;
  issuedAt?: string;
  periodStart?: string;
  periodEnd?: string;
  externalInvoicingId?: string;
  invoiceType: "stripe_connect" | "auto_topup" | "payment" | "pending_usage";
  /** Card brand / LINK when this invoice was paid off-session. */
  paymentMethodBrand?: string | null;
  /**
   * Friendly reason the most recent automatic charge attempt on this
   * invoice failed ("Your card was declined for insufficient funds."), or
   * null when the invoice has no failed attempt on record. Distinct from
   * `status`, which stays `"open"` while Stripe keeps retrying — this is
   * what a customer needs to actually understand why.
   */
  paymentFailureMessage?: string | null;
};

/**
 * Friendly, non-technical reading of a Stripe decline. Deliberately coarse —
 * "we could not charge your payment method" covers the long tail — with a
 * handful of the most common, most actionable codes called out by name so a
 * customer with a fixable problem (an expired card, a thin balance) knows
 * what to go do about it instead of just retrying blind.
 */
const FRIENDLY_DECLINE_MESSAGES: Record<string, string> = {
  insufficient_funds: "Your card was declined for insufficient funds.",
  card_declined: "Your card was declined.",
  expired_card: "Your card has expired.",
  incorrect_cvc: "Your card's security code was incorrect.",
  processing_error: "There was an error processing your card. Please try again.",
  lost_card: "Your card was declined.",
  stolen_card: "Your card was declined.",
};

export function friendlyPaymentFailureMessage(
  error: StripePaymentError | null | undefined,
): string | null {
  if (!error) return null;
  const code = error.decline_code?.trim() || error.code?.trim();
  if (code && FRIENDLY_DECLINE_MESSAGES[code]) {
    return FRIENDLY_DECLINE_MESSAGES[code];
  }
  return "We could not charge your payment method.";
}

/** Human label for a Connect payment method (LINK, VISA, …). */
export function stripePaymentMethodBrandLabel(
  paymentMethod: StripeConnectPaymentMethod | string | null | undefined,
): string | null {
  if (!paymentMethod || typeof paymentMethod === "string") {
    return null;
  }
  const type = paymentMethod.type?.trim().toLowerCase() || "";
  if (type === "link" || paymentMethod.link) {
    return "LINK";
  }
  const cardBrand = paymentMethod.card?.brand?.trim();
  if (cardBrand) {
    return cardBrand.toUpperCase();
  }
  if (type) {
    return type.replaceAll("_", " ").toUpperCase();
  }
  return null;
}

/** Resolve Merchant Connect livemode from app billing config (default live). */
export function appStripeLivemode(
  config: { stripeLivemode?: boolean | null } | null | undefined,
): boolean {
  return config?.stripeLivemode !== false;
}

export type ResolveAppLivemodeForWebhook = (
  clientId: string,
) => Promise<boolean>;

let resolveAppLivemodeForWebhookForTests: ResolveAppLivemodeForWebhook | null =
  null;

/**
 * Test-only override for webhook plane livemode checks (PM restore).
 * Always `null` (inert) outside NODE_ENV=test.
 */
export function __setResolveAppLivemodeForWebhookForTests(
  fn: ResolveAppLivemodeForWebhook | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__setResolveAppLivemodeForWebhookForTests is only available in test",
    );
  }
  resolveAppLivemodeForWebhookForTests = fn;
}

/**
 * True when the app's stored stripeLivemode matches the webhook ingress plane.
 * Sandbox deliveries must not mutate live apps (and vice versa).
 */
export async function appLivemodeMatchesWebhookPlane(
  clientId: string,
  expectedLivemode: boolean,
): Promise<boolean> {
  if (resolveAppLivemodeForWebhookForTests) {
    const appLivemode = await resolveAppLivemodeForWebhookForTests(clientId);
    return appLivemode === expectedLivemode;
  }
  const config = await getAppBillingConfig(clientId);
  return appStripeLivemode(config) === expectedLivemode;
}

/**
 * Livemode for a new Merchant Connect onboarding (no acct_ yet).
 * Linked accounts and merchant-mode apps keep stored stripeLivemode (live
 * unless explicitly sandbox). First Connect from owner_rollup defaults to
 * sandbox unless the operator already PATCHed stripeLivemode true.
 */
export function merchantConnectOnboardingLivemode(
  config: {
    stripeLivemode?: boolean | null;
    billingMode?: string | null;
    stripeConnectedAccountId?: string | null;
  } | null | undefined,
): boolean {
  if (config?.stripeConnectedAccountId?.trim()) {
    return appStripeLivemode(config);
  }
  if (config?.billingMode === "merchant") {
    return appStripeLivemode(config);
  }
  return config?.stripeLivemode === true;
}

/**
 * Live vs sandbox for `startMerchantConnect`.
 * An explicit Payments-toggle value wins until a Connected Account is linked.
 */
export function resolveStartMerchantConnectLivemode(input: {
  requestedLivemode?: boolean;
  config: {
    stripeLivemode?: boolean | null;
    billingMode?: string | null;
    stripeConnectedAccountId?: string | null;
  } | null | undefined;
}): boolean {
  const linked = Boolean(input.config?.stripeConnectedAccountId?.trim());
  if (typeof input.requestedLivemode === "boolean" && !linked) {
    return input.requestedLivemode;
  }
  return merchantConnectOnboardingLivemode(input.config);
}

function stripeSecretKey(livemode = true): string {
  return resolveStripePlatformSecretKey(livemode);
}

function invoiceDate(seconds: number | null | undefined): string | undefined {
  return typeof seconds === "number"
    ? new Date(seconds * 1_000).toISOString()
    : undefined;
}

async function stripeConnectInvoiceRequest<T>(
  accountId: string,
  path: string,
  livemode = true,
): Promise<T> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: {
      Authorization: `Bearer ${stripeSecretKey(livemode)}`,
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

function mapMerchantInvoice(
  invoice: StripeConnectInvoice,
  paymentMethodBrand?: string | null,
): MerchantBillingHistoryItem | null {
  const id = invoice.id?.trim();
  if (!id) return null;
  const status = invoice.status?.trim() || "unknown";
  return {
    id,
    number: invoice.number?.trim() || undefined,
    status,
    currency: invoice.currency?.toUpperCase() || "USD",
    totalAmount: ((invoice.total ?? 0) / 100).toFixed(2),
    customerId: invoice.customer?.trim() || undefined,
    issuedAt: invoiceDate(invoice.created),
    periodStart: invoiceDate(invoice.period_start),
    periodEnd: invoiceDate(invoice.period_end),
    externalInvoicingId: id,
    invoiceType: "stripe_connect",
    paymentMethodBrand: paymentMethodBrand?.trim() || null,
    // Once paid or void the invoice is resolved — a PaymentIntent's
    // last_payment_error is a record of its most recent failed *attempt*,
    // which can predate a later attempt that succeeded, so surfacing it on
    // a paid/void invoice would misreport it as still failing.
    paymentFailureMessage:
      status === "paid" || status === "void" ? null : invoicePaymentFailureMessage(invoice),
  };
}

function invoicePaymentFailureMessage(invoice: StripeConnectInvoice): string | null {
  const fromFinalization = friendlyPaymentFailureMessage(invoice.last_finalization_error);
  if (fromFinalization) return fromFinalization;
  const pi = invoice.payment_intent;
  if (pi && typeof pi === "object") {
    return friendlyPaymentFailureMessage(pi.last_payment_error);
  }
  return null;
}

function mapLegacyAutoTopUpPaymentIntent(
  pi: StripeConnectPaymentIntent,
): MerchantBillingHistoryItem | null {
  const id = pi.id?.trim();
  if (!id?.startsWith("pi_")) return null;
  if (!isLegacyAutoTopUpPaymentIntentMetadata(pi.metadata)) return null;
  const status = pi.status?.trim() || "unknown";
  // History shows completed top-ups; failed/requires_action stay out of the list.
  if (status !== "succeeded") return null;
  return {
    id,
    number: "Auto top-up",
    status,
    currency: pi.currency?.toUpperCase() || "USD",
    totalAmount: ((pi.amount ?? 0) / 100).toFixed(2),
    customerId: pi.customer?.trim() || undefined,
    issuedAt: invoiceDate(pi.created),
    externalInvoicingId: id,
    invoiceType: "auto_topup",
  };
}

/**
 * Merchant billing history includes Stripe invoices plus any succeeded
 * PaymentIntent on the Connect customer (legacy auto top-ups and ad-hoc
 * charges). One-time Dashboard/Checkout charges without invoice rows would
 * otherwise never appear.
 *
 * Invoice-backed PaymentIntents are omitted — the invoice row is the
 * canonical history entry (avoids duplicate billed amounts).
 */
function mapMerchantPaymentIntent(
  pi: StripeConnectPaymentIntent,
): MerchantBillingHistoryItem | null {
  if (paymentIntentInvoiceId(pi)) {
    return null;
  }
  const legacy = mapLegacyAutoTopUpPaymentIntent(pi);
  if (legacy) return legacy;
  const id = pi.id?.trim();
  if (!id?.startsWith("pi_")) return null;
  const status = pi.status?.trim() || "unknown";
  if (status !== "succeeded") return null;
  const amount = pi.amount ?? 0;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    id,
    number: "Payment",
    status,
    currency: pi.currency?.toUpperCase() || "USD",
    totalAmount: (amount / 100).toFixed(2),
    customerId: pi.customer?.trim() || undefined,
    issuedAt: invoiceDate(pi.created),
    externalInvoicingId: id,
    invoiceType: "payment",
  };
}

/** @internal Exported for unit tests. */
function paymentIntentInvoiceId(
  pi: StripeConnectPaymentIntent,
): string | null {
  const raw = pi.invoice;
  if (typeof raw === "string") {
    const id = raw.trim();
    return id.startsWith("in_") ? id : null;
  }
  if (raw && typeof raw === "object") {
    const id = raw.id?.trim();
    return id?.startsWith("in_") ? id : null;
  }
  return null;
}

/** @internal Exported for unit tests. */
export const __testMerchantConnectInvoices = {
  invoiceDate,
  mapMerchantInvoice,
  mapLegacyAutoTopUpPaymentIntent,
  mapMerchantPaymentIntent,
  paymentIntentInvoiceId,
  paymentBrandByInvoiceId,
  stripePaymentMethodBrandLabel,
  stripeConnectInvoiceRequest,
};
/** @internal Exported for unit tests. */
export const __testMapMerchantInvoice = mapMerchantInvoice;

export type MerchantConnectPlane =
  typeof appStripeConnectAccounts.$inferSelect;

/** Drizzle handle used inside plane-switch transactions (or the global `db`). */
type ConnectDb = Pick<Db, "select" | "insert" | "update" | "delete">;

function coerceOnboardingMethod(
  value: string | null | undefined,
): StripeOnboardingMethod | null {
  if (value === "account_link" || value === "oauth") {
    return value;
  }
  return null;
}

/** Parked Merchant Connect state for one Stripe plane, if the app onboarded it. */
export async function getMerchantConnectPlane(
  clientId: string,
  livemode: boolean,
  exec: ConnectDb = db,
): Promise<MerchantConnectPlane | null> {
  const rows = await exec
    .select()
    .from(appStripeConnectAccounts)
    .where(
      and(
        eq(appStripeConnectAccounts.clientId, clientId),
        eq(appStripeConnectAccounts.livemode, livemode),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Mirror the active plane's Connect state into its parked row, so switching
 * away and back does not require re-onboarding.
 */
async function parkConnectedAccountPlane(
  input: {
    clientId: string;
    livemode: boolean;
    accountId: string;
    onboardingMethod?: StripeOnboardingMethod | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    connectedAt: string | null;
  },
  exec: ConnectDb = db,
): Promise<void> {
  const existing = await getMerchantConnectPlane(
    input.clientId,
    input.livemode,
    exec,
  );
  const now = new Date().toISOString();
  const values = {
    stripeConnectedAccountId: input.accountId,
    stripeChargesEnabled: input.chargesEnabled,
    stripePayoutsEnabled: input.payoutsEnabled,
    stripeDetailsSubmitted: input.detailsSubmitted,
    connectedAt: input.connectedAt,
    // Keep a previously recorded method when the caller has nothing better.
    stripeOnboardingMethod:
      input.onboardingMethod ??
      coerceOnboardingMethod(existing?.stripeOnboardingMethod) ??
      null,
    updatedAt: now,
  };
  if (existing) {
    await exec
      .update(appStripeConnectAccounts)
      .set(values)
      .where(eq(appStripeConnectAccounts.id, existing.id));
    return;
  }
  await exec.insert(appStripeConnectAccounts).values({
    id: uuidv4(),
    clientId: input.clientId,
    livemode: input.livemode,
    createdAt: now,
    ...values,
  });
}

/** Forget one plane's onboarding (disconnect); the other plane is untouched. */
export async function forgetMerchantConnectPlane(
  clientId: string,
  livemode: boolean,
): Promise<void> {
  await db
    .delete(appStripeConnectAccounts)
    .where(
      and(
        eq(appStripeConnectAccounts.clientId, clientId),
        eq(appStripeConnectAccounts.livemode, livemode),
      ),
    );
}

async function persistConnectedAccountFlags(input: {
  clientId: string;
  accountId: string;
  livemode: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}): Promise<void> {
  const ready = input.chargesEnabled && input.detailsSubmitted;
  const existing = await getAppBillingConfig(input.clientId);
  const merchantProfileId =
    existing?.openmeterMerchantBillingProfileId?.trim() ||
    process.env.OPENMETER_MERCHANT_BILLING_PROFILE_ID?.trim() ||
    null;
  const connectedAt = ready
    ? (existing?.connectedAt ?? new Date().toISOString())
    : (existing?.connectedAt ?? null);
  // Do not write stripeConnectStatus here — that column is Plane A (OM Stripe
  // app install). Merchant readiness is stripeChargesEnabled + detailsSubmitted.
  await upsertAppBillingConfig(input.clientId, {
    stripeConnectedAccountId: input.accountId,
    stripeChargesEnabled: input.chargesEnabled,
    stripePayoutsEnabled: input.payoutsEnabled,
    stripeDetailsSubmitted: input.detailsSubmitted,
    connectedAt,
    ...(existing?.billingMode === "merchant" && merchantProfileId
      ? { openmeterMerchantBillingProfileId: merchantProfileId }
      : {}),
  });
  await parkConnectedAccountPlane({
    clientId: input.clientId,
    livemode: input.livemode,
    accountId: input.accountId,
    onboardingMethod: coerceOnboardingMethod(existing?.stripeOnboardingMethod),
    chargesEnabled: input.chargesEnabled,
    payoutsEnabled: input.payoutsEnabled,
    detailsSubmitted: input.detailsSubmitted,
    connectedAt,
  });
}

async function syncConnectedAccountFlags(
  clientId: string,
  accountId: string,
  livemode = true,
): Promise<{
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}> {
  const status = await refreshConnectedAccountStatus(accountId, livemode);
  await persistConnectedAccountFlags({
    clientId,
    accountId,
    livemode,
    chargesEnabled: status.chargesEnabled,
    payoutsEnabled: status.payoutsEnabled,
    detailsSubmitted: status.detailsSubmitted,
  });
  // Keep invoice supplier columns in sync whenever we refresh Connect flags
  // (return URL, Account Link refresh, GET status). Webhook path uses the
  // same helper — without this, merchant mode sees empty country/name.
  await syncSupplierBestEffort(clientId, accountId, livemode);
  return {
    chargesEnabled: status.chargesEnabled,
    payoutsEnabled: status.payoutsEnabled,
    detailsSubmitted: status.detailsSubmitted,
  };
}

async function syncSupplierBestEffort(
  clientId: string,
  accountId: string,
  livemode = true,
): Promise<void> {
  try {
    const { syncTenantSupplierFromConnect } = await import(
      "@/lib/openmeter/supplier-sync"
    );
    await syncTenantSupplierFromConnect({
      clientId,
      accountId,
      livemode,
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
 * No-ops when the acct_ is not the app's active account, or when the app's
 * stripeLivemode does not match the webhook plane (`ignored: livemode_mismatch`).
 *
 * Updates for a parked (non-active) plane are therefore dropped; switching back
 * to that plane re-reads the account from Stripe, so nothing is lost.
 */
export async function applyConnectedAccountWebhookUpdate(input: {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** Webhook plane: live ingress must not mutate sandbox apps, and vice versa. */
  expectedLivemode: boolean;
}): Promise<{ updated: boolean; clientId?: string; ignored?: string }> {
  const rows = await db
    .select({ clientId: appBillingConfig.clientId })
    .from(appBillingConfig)
    .where(eq(appBillingConfig.stripeConnectedAccountId, input.accountId))
    .limit(1);
  const clientId = rows[0]?.clientId;
  if (!clientId) {
    return { updated: false };
  }
  const config = await getAppBillingConfig(clientId);
  if (appStripeLivemode(config) !== input.expectedLivemode) {
    return { updated: false, clientId, ignored: "livemode_mismatch" };
  }
  await persistConnectedAccountFlags({
    clientId,
    accountId: input.accountId,
    livemode: input.expectedLivemode,
    chargesEnabled: input.chargesEnabled,
    payoutsEnabled: input.payoutsEnabled,
    detailsSubmitted: input.detailsSubmitted,
  });
  await syncSupplierBestEffort(
    clientId,
    input.accountId,
    input.expectedLivemode,
  );
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
  stripeLivemode: requestedLivemode,
}: {
  clientId: string;
  /** Reserved for audit / future session binding; Account Links do not persist OAuth state. */
  userId: string;
  mode?: MerchantConnectMode;
  email?: string;
  displayName?: string;
  /** Selected Live/Sandbox mode from Payments. Ignored once an acct_ is linked. */
  stripeLivemode?: boolean;
}): Promise<{ method: "account_link"; url: string; accountId: string }> {
  await ensureOmStarterSideEffect(clientId);

  let existing = await getAppBillingConfig(clientId);
  const linkedAccountId = existing?.stripeConnectedAccountId?.trim() || "";
  // Persist the Payments toggle on this request. Complete-onboarding used to
  // ignore the selected mode and fall through to the owner_rollup sandbox default.
  if (typeof requestedLivemode === "boolean" && !linkedAccountId) {
    await upsertAppBillingConfig(clientId, { stripeLivemode: requestedLivemode });
    existing = await getAppBillingConfig(clientId);
  }
  const livemode = resolveStartMerchantConnectLivemode({
    requestedLivemode,
    config: existing,
  });
  // Resume this plane's own onboarding. After a plane switch the active config
  // has no account, but the plane may already have a parked acct_ to finish.
  const parked = await getMerchantConnectPlane(clientId, livemode);
  let accountId =
    linkedAccountId || (parked?.stripeConnectedAccountId?.trim() ?? "");
  if (!accountId) {
    accountId = await createMerchantConnectedAccount({
      clientId,
      email,
      displayName,
      livemode,
    });
  }
  if (accountId !== linkedAccountId) {
    await upsertAppBillingConfig(clientId, {
      stripeConnectedAccountId: accountId,
      stripeOnboardingMethod: "account_link" satisfies StripeOnboardingMethod,
      stripeChargesEnabled: parked?.stripeChargesEnabled ?? false,
      stripePayoutsEnabled: parked?.stripePayoutsEnabled ?? false,
      stripeDetailsSubmitted: parked?.stripeDetailsSubmitted ?? false,
      connectedAt: parked?.connectedAt ?? null,
      stripeLivemode: livemode,
    });
  }

  const urls = connectAccountLinkUrls(clientId);
  const linkUrl = await createAccountOnboardingLink({
    accountId,
    refreshUrl: urls.refreshUrl,
    returnUrl: urls.returnUrl,
    livemode,
  });
  await syncConnectedAccountFlags(clientId, accountId, livemode);
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
  const livemode = appStripeLivemode(config);
  const urls = connectAccountLinkUrls(clientId);
  const url = await createAccountOnboardingLink({
    accountId,
    refreshUrl: urls.refreshUrl,
    returnUrl: urls.returnUrl,
    livemode,
  });
  await syncConnectedAccountFlags(clientId, accountId, livemode);
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

  const existing = await getAppBillingConfig(input.clientId);
  const livemode = merchantConnectOnboardingLivemode(existing);
  const accountId = await exchangeConnectOAuthCode(input.code, livemode);
  await upsertAppBillingConfig(input.clientId, {
    stripeConnectedAccountId: accountId,
    stripeOnboardingMethod: "oauth",
    stripeLivemode: livemode,
  });
  await syncConnectedAccountFlags(input.clientId, accountId, livemode);
  await ensureOmStarterSideEffect(input.clientId);
}

export type MerchantConnectPlaneSwitch = {
  changed: boolean;
  livemode: boolean;
  /** Account restored for the target plane, or null when it needs onboarding. */
  accountId: string | null;
  /** True when the target plane can already charge end users. */
  ready: boolean;
};

/** Stripe-derived supplier identity, cleared when leaving a plane. */
const CONNECT_SUPPLIER_RESET = {
  supplierCountry: null,
  supplierName: null,
  supplierBusinessType: null,
  supplierAddressLine1: null,
  supplierAddressLine2: null,
  supplierAddressCity: null,
  supplierAddressState: null,
  supplierAddressPostalCode: null,
  supplierTaxIdOnFileAtStripe: false,
  supplierSyncedAt: null,
} as const;

/**
 * Move the app between the sandbox and live Stripe planes.
 *
 * The plane being left is parked first, so its Connected Account survives; the
 * target plane's parked row (if any) is restored into `app_billing_config`,
 * which is what every consumer reads. Developer-supplied `supplierTaxId` is
 * kept — the rest of the supplier identity is re-derived from the target
 * account by the flag sync below.
 *
 * Park + restore run in one transaction with a row lock on `app_billing_config`
 * so overlapping switches serialize. Stripe flag refresh stays outside the
 * transaction (network I/O must not hold the lock).
 *
 * Callers own the caveat that `billingMode: "merchant"` on a plane that has not
 * finished onboarding cannot sell paid plans until it does.
 */
export async function switchMerchantConnectPlane(input: {
  clientId: string;
  livemode: boolean;
}): Promise<MerchantConnectPlaneSwitch> {
  const { clientId, livemode } = input;

  type SwitchDbResult =
    | {
        changed: false;
        livemode: boolean;
        accountId: string | null;
        ready: boolean;
      }
    | {
        changed: true;
        livemode: boolean;
        accountId: string | null;
      };

  const dbResult: SwitchDbResult = await db.transaction(async (tx) => {
    // Serialize overlapping plane switches for this app.
    const locked = await tx
      .select()
      .from(appBillingConfig)
      .where(eq(appBillingConfig.clientId, clientId))
      .for("update")
      .limit(1);
    const config = locked[0] ?? null;
    const activeAccountId = config?.stripeConnectedAccountId?.trim() || "";

    if (config && appStripeLivemode(config) === livemode) {
      return {
        changed: false as const,
        livemode,
        accountId: activeAccountId || null,
        ready: isMerchantConnectPaymentsReady(config),
      };
    }

    if (activeAccountId && config) {
      await parkConnectedAccountPlane(
        {
          clientId,
          livemode: appStripeLivemode(config),
          accountId: activeAccountId,
          onboardingMethod: coerceOnboardingMethod(config.stripeOnboardingMethod),
          chargesEnabled: config.stripeChargesEnabled ?? false,
          payoutsEnabled: config.stripePayoutsEnabled ?? false,
          detailsSubmitted: config.stripeDetailsSubmitted ?? false,
          connectedAt: config.connectedAt ?? null,
        },
        tx,
      );
    }

    const target = await getMerchantConnectPlane(clientId, livemode, tx);
    const now = new Date().toISOString();
    const restored = {
      stripeLivemode: livemode,
      stripeConnectedAccountId: target?.stripeConnectedAccountId ?? null,
      stripeOnboardingMethod: target?.stripeOnboardingMethod ?? null,
      stripeChargesEnabled: target?.stripeChargesEnabled ?? false,
      stripePayoutsEnabled: target?.stripePayoutsEnabled ?? false,
      stripeDetailsSubmitted: target?.stripeDetailsSubmitted ?? false,
      connectedAt: target?.connectedAt ?? null,
      ...CONNECT_SUPPLIER_RESET,
      updatedAt: now,
    };

    if (config) {
      await tx
        .update(appBillingConfig)
        .set(restored)
        .where(eq(appBillingConfig.clientId, clientId));
    } else {
      await tx.insert(appBillingConfig).values({
        id: uuidv4(),
        clientId,
        stripeConnectStatus: "disconnected",
        defaultCurrency: "USD",
        endUserCap: platformDefaultEndUserCap(),
        applicationFeeBps: platformDefaultApplicationFeeBps(),
        createdAt: now,
        ...restored,
      });
    }

    const targetAccountId = target?.stripeConnectedAccountId?.trim() || "";
    return {
      changed: true as const,
      livemode,
      accountId: targetAccountId || null,
    };
  });

  if (!dbResult.changed) {
    return dbResult;
  }

  const targetAccountId = dbResult.accountId;
  if (!targetAccountId) {
    return { changed: true, livemode, accountId: null, ready: false };
  }

  // Flags parked on the way out can be stale; re-read Stripe (and re-derive
  // supplier) so the restored plane reports what it can actually do now.
  try {
    await syncConnectedAccountFlags(clientId, targetAccountId, livemode);
  } catch (err) {
    console.warn(
      "Connect flag refresh after plane switch failed",
      sanitizeForLog(clientId),
      sanitizeForLog(err),
    );
  }
  const refreshed = await getAppBillingConfig(clientId);
  return {
    changed: true,
    livemode,
    accountId: targetAccountId,
    ready: isMerchantConnectPaymentsReady(refreshed),
  };
}

export async function syncMerchantConnectStatus(clientId: string): Promise<void> {
  const config = await getAppBillingConfig(clientId);
  const accountId = config?.stripeConnectedAccountId?.trim();
  if (!accountId) {
    return;
  }
  await syncConnectedAccountFlags(clientId, accountId, appStripeLivemode(config));
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

/**
 * OpenMeter customer stamped on `app_user_stripe_customers`.
 *
 * Callers (payment-method checkout, cutover scripts) still pass the legacy
 * compound `app_…:externalUserId` key. Persist the retail customer instead —
 * `eu_{end_users.id}` for end-users even under owner_rollup /
 * connectPaymentsOnly — so Stripe customers point at the card holder, not
 * the owner wallet.
 *
 * Trust a caller/stored OpenMeter id only when its key already matches that
 * canonical retail customer; otherwise drop the id rather than keep a
 * legacy or owner-wallet customer.
 */
async function resolveCanonicalOpenMeterCustomerLink(input: {
  clientId: string;
  externalUserId: string;
  openmeterCustomerId?: string | null;
  openmeterCustomerKey?: string | null;
  storedCustomerId?: string | null;
  storedCustomerKey?: string | null;
}): Promise<{
  openmeterCustomerKey: string;
  openmeterCustomerId: string | null;
}> {
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const openmeterCustomerKey = appUserRetailCustomerKey(identity);
  const callerKey = input.openmeterCustomerKey?.trim() || "";
  const callerId = input.openmeterCustomerId?.trim() || "";
  if (callerKey === openmeterCustomerKey && callerId) {
    return {
      openmeterCustomerKey,
      openmeterCustomerId: callerId,
    };
  }
  const storedKey = input.storedCustomerKey?.trim() || "";
  const storedId = input.storedCustomerId?.trim() || "";
  if (storedKey === openmeterCustomerKey && storedId) {
    return {
      openmeterCustomerKey,
      openmeterCustomerId: storedId,
    };
  }
  return {
    openmeterCustomerKey,
    openmeterCustomerId: null,
  };
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
        eq(
          appUserStripeCustomers.stripeConnectedAccountId,
          input.stripeConnectedAccountId,
        ),
      ),
    )
    .limit(1);
  const canonical = await resolveCanonicalOpenMeterCustomerLink({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    openmeterCustomerId: input.openmeterCustomerId,
    openmeterCustomerKey: input.openmeterCustomerKey,
    storedCustomerId: existing[0]?.openmeterCustomerId,
    storedCustomerKey: existing[0]?.openmeterCustomerKey,
  });
  const now = new Date().toISOString();
  if (existing[0]) {
    await db
      .update(appUserStripeCustomers)
      .set({
        stripeCustomerId: input.stripeCustomerId,
        openmeterCustomerId: canonical.openmeterCustomerId,
        openmeterCustomerKey: canonical.openmeterCustomerKey,
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
    openmeterCustomerId: canonical.openmeterCustomerId,
    openmeterCustomerKey: canonical.openmeterCustomerKey,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * An app user holds one Stripe customer per connected account, so the account
 * is part of the lookup — without it a live-plane read can return the sandbox
 * `cus_` (or the reverse).
 */
export async function getAppUserStripeCustomer(input: {
  clientId: string;
  externalUserId: string;
  stripeConnectedAccountId: string;
}): Promise<typeof appUserStripeCustomers.$inferSelect | null> {
  const rows = await db
    .select()
    .from(appUserStripeCustomers)
    .where(
      and(
        eq(appUserStripeCustomers.clientId, input.clientId),
        eq(appUserStripeCustomers.externalUserId, input.externalUserId),
        eq(
          appUserStripeCustomers.stripeConnectedAccountId,
          input.stripeConnectedAccountId,
        ),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Reverse map: Connect `cus_…` → app user (for payment_method.attached restore). */
export async function findAppUserStripeCustomerByStripeId(
  stripeCustomerId: string,
): Promise<typeof appUserStripeCustomers.$inferSelect | null> {
  const trimmed = stripeCustomerId.trim();
  if (!trimmed.startsWith("cus_")) {
    return null;
  }
  const rows = await db
    .select()
    .from(appUserStripeCustomers)
    .where(eq(appUserStripeCustomers.stripeCustomerId, trimmed))
    .limit(1);
  return rows[0] ?? null;
}

const STRIPE_INVOICE_PAGE_LIMIT = 100;
/** Cap Stripe pagination so a pathological customer cannot loop forever. */
const MAX_MERCHANT_INVOICE_PAGES = 50;

async function listAllMerchantConnectInvoices(
  accountId: string,
  stripeCustomerId: string,
  livemode = true,
): Promise<StripeConnectInvoice[]> {
  const invoices: StripeConnectInvoice[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_MERCHANT_INVOICE_PAGES; page++) {
    const params = new URLSearchParams({
      customer: stripeCustomerId,
      limit: String(STRIPE_INVOICE_PAGE_LIMIT),
      "expand[]": "data.payment_intent",
    });
    if (startingAfter) {
      params.set("starting_after", startingAfter);
    }
    const result = await stripeConnectInvoiceRequest<{
      data?: StripeConnectInvoice[];
      has_more?: boolean;
    }>(accountId, `/v1/invoices?${params.toString()}`, livemode);
    const batch = result.data ?? [];
    invoices.push(...batch);
    if (!result.has_more || batch.length === 0) {
      break;
    }
    const lastId = batch.at(-1)?.id?.trim();
    if (!lastId) {
      break;
    }
    startingAfter = lastId;
  }
  return invoices;
}

async function listAllMerchantConnectPaymentIntents(
  accountId: string,
  stripeCustomerId: string,
  livemode = true,
): Promise<StripeConnectPaymentIntent[]> {
  const intents: StripeConnectPaymentIntent[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_MERCHANT_INVOICE_PAGES; page++) {
    const params = new URLSearchParams({
      customer: stripeCustomerId,
      limit: String(STRIPE_INVOICE_PAGE_LIMIT),
      "expand[]": "data.payment_method",
    });
    if (startingAfter) {
      params.set("starting_after", startingAfter);
    }
    const result = await stripeConnectInvoiceRequest<{
      data?: StripeConnectPaymentIntent[];
      has_more?: boolean;
    }>(accountId, `/v1/payment_intents?${params.toString()}`, livemode);
    const batch = result.data ?? [];
    intents.push(...batch);
    if (!result.has_more || batch.length === 0) {
      break;
    }
    const lastId = batch.at(-1)?.id?.trim();
    if (!lastId) {
      break;
    }
    startingAfter = lastId;
  }
  return intents;
}

/** invoice id → brand from the PI that settled it (LINK, VISA, …). */
function paymentBrandByInvoiceId(
  paymentIntents: StripeConnectPaymentIntent[],
): Map<string, string> {
  const brands = new Map<string, string>();
  for (const pi of paymentIntents) {
    if ((pi.status?.trim() || "") !== "succeeded") continue;
    const invoiceId = paymentIntentInvoiceId(pi);
    if (!invoiceId || brands.has(invoiceId)) continue;
    const brand = stripePaymentMethodBrandLabel(pi.payment_method);
    if (brand) {
      brands.set(invoiceId, brand);
    }
  }
  return brands;
}

function billingHistorySortKey(item: MerchantBillingHistoryItem): number {
  const iso = item.issuedAt?.trim();
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * List invoices + standalone succeeded PaymentIntents from the merchant's
 * Connected Account for one app user (newest first). Invoice-backed intents
 * are omitted so the same charge is not listed twice.
 * Merchant billing never reads OpenMeter owner-rollup invoices.
 */
export async function listMerchantConnectInvoicesForAppUser(input: {
  clientId: string;
  externalUserId: string;
  page: number;
  pageSize: number;
}): Promise<{
  items: MerchantBillingHistoryItem[];
  page: number;
  pageSize: number;
  totalCount: number;
}> {
  const config = await getAppBillingConfig(input.clientId);
  if (!isMerchantConnectPaymentsReady(config)) {
    return { items: [], page: input.page, pageSize: input.pageSize, totalCount: 0 };
  }
  const accountId = config?.stripeConnectedAccountId?.trim();
  if (!accountId) {
    return { items: [], page: input.page, pageSize: input.pageSize, totalCount: 0 };
  }
  const customer = await getAppUserStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: accountId,
  });
  if (!customer?.stripeCustomerId?.trim()) {
    return { items: [], page: input.page, pageSize: input.pageSize, totalCount: 0 };
  }
  const offset = (input.page - 1) * input.pageSize;
  const livemode = appStripeLivemode(config);
  const [invoiceRows, paymentIntentRows] = await Promise.all([
    listAllMerchantConnectInvoices(accountId, customer.stripeCustomerId, livemode),
    listAllMerchantConnectPaymentIntents(
      accountId,
      customer.stripeCustomerId,
      livemode,
    ),
  ]);
  const paidBrands = paymentBrandByInvoiceId(paymentIntentRows);
  const invoices = invoiceRows
    .map((invoice) => {
      const id = invoice.id?.trim();
      return mapMerchantInvoice(
        invoice,
        id ? paidBrands.get(id) ?? null : null,
      );
    })
    .filter((invoice): invoice is MerchantBillingHistoryItem => invoice !== null);
  const topUps = paymentIntentRows
    .map((pi) => mapMerchantPaymentIntent(pi))
    .filter((row): row is MerchantBillingHistoryItem => row !== null);
  const merged = [...invoices, ...topUps].sort(
    (a, b) => billingHistorySortKey(b) - billingHistorySortKey(a),
  );
  const items = merged.slice(offset, offset + input.pageSize);

  // Usage that has accrued but has not yet become a Stripe invoice object
  // (still gathering on OpenMeter, or mid-raise through settlement) would
  // otherwise be invisible here — this list only ever reflects Stripe's own
  // invoices/payment intents. Surface it as a synthetic row instead, so a
  // charge that has landed but not yet invoiced does not look like it never
  // happened. Skipped once a real Stripe invoice already carries the same
  // not-yet-final debt, so the amount is never shown twice; page 1 only,
  // since it reflects current state rather than a specific list entry.
  if (input.page === 1) {
    const pending = await pendingUsageBillingHistoryItem(input, invoices);
    if (pending) {
      items.unshift(pending);
    }
  }

  return {
    items,
    page: input.page,
    pageSize: input.pageSize,
    totalCount: merged.length,
  };
}

/** Stripe invoice statuses that still represent live, uncollected debt. */
const OPEN_STRIPE_INVOICE_STATUSES = new Set(["draft", "open"]);

/**
 * Whether a real Stripe invoice already carries the debt a synthetic
 * "pending usage" row would otherwise show — draft and open both still
 * represent live, uncollected debt, so either makes the synthetic row
 * redundant (and, once collected, `paid`/`void`/`uncollectible` should not
 * suppress it: any debt accrued *since* that invoice closed is genuinely new
 * and unrepresented).
 */
export function hasOpenOrDraftInvoice(
  invoices: Pick<MerchantBillingHistoryItem, "status">[],
): boolean {
  return invoices.some((invoice) => OPEN_STRIPE_INVOICE_STATUSES.has(invoice.status));
}

/** Pure mapping from an unbilled-debt read to the synthetic history row. */
export function buildPendingUsageBillingHistoryItem(
  usdMicros: bigint,
  now: Date = new Date(),
): MerchantBillingHistoryItem | null {
  if (usdMicros <= 0n) {
    return null;
  }
  return {
    id: "pending_usage",
    status: "pending",
    currency: "USD",
    totalAmount: formatUsdMicrosForDisplay(usdMicros.toString()),
    issuedAt: now.toISOString(),
    invoiceType: "pending_usage",
  };
}

async function pendingUsageBillingHistoryItem(
  input: { clientId: string; externalUserId: string },
  invoices: MerchantBillingHistoryItem[],
): Promise<MerchantBillingHistoryItem | null> {
  if (hasOpenOrDraftInvoice(invoices)) {
    return null;
  }
  const debt = await getUnbilledDebtDetails(input);
  return buildPendingUsageBillingHistoryItem(debt.usdMicros);
}

/**
 * Sum of this Connect customer's `paid` Stripe invoices *and* standalone
 * succeeded PaymentIntents (Checkout top-ups) whose `created` timestamp
 * falls in the current UTC calendar month — used to net the calendar-month
 * meter estimate (see unbilled-debt.ts) down to genuinely unbilled usage.
 *
 * The meter estimate exists as a fallback for when Konnect's own invoice
 * list can't be trusted (its customer filter is unreliable), but it sums
 * *all* usage in the window regardless of whether some of it was already
 * paid earlier in the same cycle. Invoice-only netting missed the common
 * prepaid path: "Add credit" is a Checkout PaymentIntent, not a Stripe
 * invoice, so a customer who topped up mid-month still looked $N in debt
 * for the rest of the month. Invoice-backed PIs are omitted so the same
 * charge is not counted twice. Stripe's `customer=` filter, unlike
 * Konnect's, is not broken — the request is scoped to one Connect
 * customer and can be trusted directly.
 *
 * `sumPaidInvoiceCentsSince` is the invoice half: `paid` invoices created
 * at/after `cycleStartSeconds` (Stripe `created` is Unix seconds). Pure so
 * the cycle-boundary and status filtering can be tested without live
 * Stripe/DB access.
 */
export function sumPaidInvoiceCentsSince(
  invoices: Pick<StripeConnectInvoice, "status" | "created" | "total">[],
  cycleStartSeconds: number,
): number {
  let paidCents = 0;
  for (const invoice of invoices) {
    if ((invoice.status?.trim() || "") !== "paid") continue;
    if ((invoice.created ?? 0) < cycleStartSeconds) continue;
    paidCents += invoice.total ?? 0;
  }
  return paidCents;
}

/**
 * Sum, in cents, of succeeded standalone PaymentIntents created at/after
 * `cycleStartSeconds`. Invoice-backed intents are skipped — those cents
 * already live on the invoice row.
 */
export function sumSucceededStandalonePaymentCentsSince(
  intents: Pick<
    StripeConnectPaymentIntent,
    "status" | "created" | "amount" | "invoice"
  >[],
  cycleStartSeconds: number,
): number {
  let paidCents = 0;
  for (const intent of intents) {
    if ((intent.status?.trim() || "") !== "succeeded") continue;
    if ((intent.created ?? 0) < cycleStartSeconds) continue;
    if (paymentIntentInvoiceId(intent)) continue;
    const amount = intent.amount ?? 0;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    paidCents += amount;
  }
  return paidCents;
}

/** Cents -> USD micros without floating point: (cents * 1_000_000) / 100. */
export function centsToUsdMicros(cents: number): bigint {
  if (!Number.isFinite(cents) || cents <= 0) return 0n;
  return (BigInt(Math.round(cents)) * 1_000_000n) / 100n;
}

export async function getMerchantPaidDebtThisCycleUsdMicros(input: {
  clientId: string;
  externalUserId: string;
}): Promise<bigint> {
  const config = await getAppBillingConfig(input.clientId);
  if (!isMerchantConnectPaymentsReady(config)) {
    return 0n;
  }
  const accountId = config?.stripeConnectedAccountId?.trim();
  if (!accountId) {
    return 0n;
  }
  const customer = await getAppUserStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: accountId,
  });
  if (!customer?.stripeCustomerId?.trim()) {
    return 0n;
  }

  const cycle = calendarMonthBoundsUtc(new Date());
  const cycleStartSeconds = Math.floor(new Date(cycle.start).getTime() / 1000);
  const livemode = appStripeLivemode(config);

  const [invoices, paymentIntents] = await Promise.all([
    listAllMerchantConnectInvoices(accountId, customer.stripeCustomerId, livemode),
    listAllMerchantConnectPaymentIntents(
      accountId,
      customer.stripeCustomerId,
      livemode,
    ),
  ]);
  return centsToUsdMicros(
    sumPaidInvoiceCentsSince(invoices, cycleStartSeconds) +
      sumSucceededStandalonePaymentCentsSince(paymentIntents, cycleStartSeconds),
  );
}

/** Resolve hosted invoice / receipt links only after proving ownership. */
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
  const invoiceId = input.invoiceId.trim();
  if (!accountId || !invoiceId) {
    return null;
  }
  const customer = await getAppUserStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: accountId,
  });
  if (!customer?.stripeCustomerId?.trim()) {
    return null;
  }

  if (invoiceId.startsWith("pi_")) {
    const pi = await stripeConnectInvoiceRequest<StripeConnectPaymentIntent>(
      accountId,
      `/v1/payment_intents/${encodeURIComponent(invoiceId)}?expand[]=latest_charge`,
      appStripeLivemode(config),
    );
    if (pi.customer !== customer.stripeCustomerId) {
      return null;
    }
    if (!isLegacyAutoTopUpPaymentIntentMetadata(pi.metadata)) {
      return null;
    }
    const charge =
      pi.latest_charge && typeof pi.latest_charge === "object"
        ? pi.latest_charge
        : null;
    const receiptUrl = charge?.receipt_url?.trim() || null;
    return { hostedInvoiceUrl: receiptUrl, invoicePdf: null };
  }

  const invoice = await stripeConnectInvoiceRequest<StripeConnectInvoice>(
    accountId,
    `/v1/invoices/${encodeURIComponent(invoiceId)}`,
    appStripeLivemode(config),
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
  livemode?: boolean;
}): Promise<string> {
  const existing = await getAppUserStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: input.accountId,
  });
  const canonical = await resolveCanonicalOpenMeterCustomerLink({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    openmeterCustomerId: input.openmeterCustomerId,
    openmeterCustomerKey: input.openmeterCustomerKey,
    storedCustomerId: existing?.openmeterCustomerId,
    storedCustomerKey: existing?.openmeterCustomerKey,
  });
  if (existing?.stripeCustomerId) {
    const keyStale =
      existing.openmeterCustomerKey !== canonical.openmeterCustomerKey;
    const idStale =
      (existing.openmeterCustomerId ?? null) !== canonical.openmeterCustomerId;
    if (keyStale || idStale) {
      await upsertAppUserStripeCustomer({
        clientId: input.clientId,
        externalUserId: input.externalUserId,
        stripeConnectedAccountId: input.accountId,
        stripeCustomerId: existing.stripeCustomerId,
        openmeterCustomerId: canonical.openmeterCustomerId,
        openmeterCustomerKey: canonical.openmeterCustomerKey,
      });
    }
    return existing.stripeCustomerId;
  }
  const stripeCustomerId = await createConnectedCustomer({
    accountId: input.accountId,
    name: input.name ?? input.externalUserId,
    livemode: input.livemode !== false,
    metadata: {
      pymthouse_client_id: input.clientId,
      external_user_id: input.externalUserId,
      ...(canonical.openmeterCustomerId
        ? { openmeter_customer_id: canonical.openmeterCustomerId }
        : {}),
      customer_key: canonical.openmeterCustomerKey,
    },
  });
  await upsertAppUserStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeConnectedAccountId: input.accountId,
    stripeCustomerId,
    openmeterCustomerId: canonical.openmeterCustomerId,
    openmeterCustomerKey: canonical.openmeterCustomerKey,
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
  const livemode = appStripeLivemode(config);
  const customerId = await ensureMerchantOwnedStripeCustomer({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    accountId,
    openmeterCustomerId: input.openmeterCustomerId,
    openmeterCustomerKey: input.openmeterCustomerKey,
    livemode,
  });
  const session = await createConnectedCheckoutSession({
    accountId,
    customerId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    mode: "setup",
    currency: config!.defaultCurrency ?? "usd",
    applicationFeeBps: config!.applicationFeeBps ?? 0,
    livemode,
    metadata: {
      pymthouse_client_id: input.clientId,
      external_user_id: input.externalUserId,
    },
  });
  return { checkoutUrl: session.url, sessionId: session.sessionId };
}
