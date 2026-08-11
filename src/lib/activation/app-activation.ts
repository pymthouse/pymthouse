import { and, count, eq } from "drizzle-orm";

import { writeAuditLog } from "@/lib/audit";
import { FALLBACK_END_USER_CAP, platformDefaultEndUserCap } from "@/lib/billing/platform-billing-defaults";
import { db } from "@/db/index";
import { appUsers, developerApps, oidcClients } from "@/db/schema";
import { appSettingsAbsoluteUrl } from "@/lib/apps/settings-paths";
import { hasPositiveUsdMicrosBalance } from "@/lib/format-usd-micros";
import { getAppBillingConfig, upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { ownerHasChargeablePaymentMethod } from "@/lib/openmeter/owner-payment-method";
import { getSpendableUsdMicros } from "@/lib/openmeter/spendable-allowance";
import { getProviderApp } from "@/lib/provider-apps";

export type BillingMode = "owner_rollup" | "merchant";

export type ActivationReason =
  | "owner_payment_method_required"
  | "end_user_cap_reached"
  | "stripe_connect_required"
  | "stripe_connect_pending";

export type AppActivation = {
  clientId: string;
  billingMode: BillingMode;
  connectReady: boolean;
  canProvisionEndUsers: boolean;
  canSellPaidPlans: boolean;
  reason: ActivationReason | null;
  endUserCap: number;
  appUserCount: number;
};

export type ActivationGateMode = "off" | "log" | "enforce_revenue" | "enforce";

export type ActivationGateKind = "provision" | "sell_paid_plans";

export class AppActivationError extends Error {
  readonly code: ActivationReason;
  readonly status: number;
  readonly billingMode: BillingMode;
  readonly actionUrl: string;
  readonly activation: AppActivation;

  constructor(input: {
    code: ActivationReason;
    message: string;
    status: number;
    billingMode: BillingMode;
    actionUrl: string;
    activation: AppActivation;
  }) {
    super(input.message);
    this.name = "AppActivationError";
    this.code = input.code;
    this.status = input.status;
    this.billingMode = input.billingMode;
    this.actionUrl = input.actionUrl;
    this.activation = input.activation;
  }
}

/**
 * Default per-app end-user cap when a billing row is missing.
 * Prefer {@link platformDefaultEndUserCap} at call sites so env policy applies;
 * this constant mirrors the unset-env fallback for tests/exports.
 */
export const DEFAULT_END_USER_CAP = FALLBACK_END_USER_CAP;

type SpendableLookup = typeof getSpendableUsdMicros;
let spendableLookup: SpendableLookup = getSpendableUsdMicros;

/** Test-only override for owner solvency lookups. */
export function __testSetSpendableLookup(fn: SpendableLookup | null): void {
  spendableLookup = fn ?? getSpendableUsdMicros;
}

type PaymentMethodLookup = typeof ownerHasChargeablePaymentMethod;
/**
 * When set, replaces the live Owner-Paid + PM overage check used after
 * spendable is exhausted. `null` from the lookup fails open (billable).
 */
let overageInvoicingLookup: PaymentMethodLookup | null = null;

/** Test-only override for owner payment-method / overage-invoicing lookups. */
export function __testSetOwnerPaymentMethodLookup(
  fn: PaymentMethodLookup | null,
): void {
  overageInvoicingLookup = fn;
}

/**
 * OpenMeter bills platform usage on `charge_automatically` only after the
 * owner upgrades to Owner Paid with a card. Sandbox Starter is a hard balance
 * gate — a card alone does not unlock overage while still on Sandbox.
 * Unknown answers (OpenMeter or Stripe unreachable) fail open — an outage must
 * not freeze provisioning.
 */
async function isOwnerBillable(input: {
  publicClientId: string;
  ownerId: string;
}): Promise<boolean> {
  const spendable = await spendableLookup({
    clientId: input.publicClientId,
    externalUserId: input.ownerId,
  });
  if (spendable == null || hasPositiveUsdMicrosBalance(spendable)) {
    return true;
  }
  if (overageInvoicingLookup) {
    // Test stubs: `null` means chargeability unknown → fail open.
    return (await overageInvoicingLookup(input.ownerId)) !== false;
  }
  const { ownerWalletAllowsOverageInvoicing } = await import(
    "@/lib/openmeter/owner-paid-plan"
  );
  return ownerWalletAllowsOverageInvoicing(input.ownerId);
}

export function getActivationGateMode(): ActivationGateMode {
  const raw = process.env.ACTIVATION_GATE_MODE?.trim().toLowerCase();
  if (raw === "log" || raw === "enforce_revenue" || raw === "enforce") {
    return raw;
  }
  return "off";
}

export function isConnectReady(config: {
  stripeConnectedAccountId?: string | null;
  stripeChargesEnabled?: boolean | null;
  stripeDetailsSubmitted?: boolean | null;
} | null | undefined): boolean {
  return Boolean(
    config?.stripeConnectedAccountId?.trim() &&
      config.stripeChargesEnabled &&
      config.stripeDetailsSubmitted,
  );
}

function normalizeBillingMode(raw: string | null | undefined): BillingMode {
  return raw === "merchant" ? "merchant" : "owner_rollup";
}

function actionUrlForReason(
  reason: ActivationReason,
  publicClientId: string,
): string {
  const base = (process.env.NEXTAUTH_URL || "http://localhost:3001").replace(/\/$/, "");
  // The owner's own card is managed on the platform billing page, not in the
  // per-app settings the other reasons point at.
  if (reason === "owner_payment_method_required") {
    return `${base}/billing`;
  }
  // Cap exhaustion is resolved by reclaiming slots (deactivate identities), not
  // by editing Payments settings — owners cannot self-raise endUserCap.
  if (reason === "end_user_cap_reached") {
    return `${base}/apps/${encodeURIComponent(publicClientId)}/identities`;
  }
  return appSettingsAbsoluteUrl(base, publicClientId, "payments");
}

function messageForReason(reason: ActivationReason): string {
  switch (reason) {
    case "owner_payment_method_required":
      return "Owner wallet is empty and cannot invoice overage — Upgrade to a paid plan with a default payment method, or add prepaid credits";
    case "end_user_cap_reached":
      return "App end-user cap reached";
    case "stripe_connect_required":
      return "Stripe Connect is required to sell paid plans";
    case "stripe_connect_pending":
      return "Stripe Connect onboarding is incomplete";
  }
}

function statusForReason(reason: ActivationReason): number {
  return reason === "owner_payment_method_required" ? 402 : 403;
}

async function resolvePublicClientId(app: typeof developerApps.$inferSelect): Promise<string> {
  if (!app.oidcClientId) {
    return app.id;
  }
  const rows = await db
    .select({ clientId: oidcClients.clientId })
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientId))
    .limit(1);
  return rows[0]?.clientId?.trim() || app.id;
}

/**
 * Resolve activation state for an app. Missing billing config → owner_rollup defaults.
 */
export async function resolveAppActivation(clientId: string): Promise<AppActivation> {
  const app = await getProviderApp(clientId);
  if (!app) {
    throw new Error(`Unknown app: ${clientId}`);
  }

  const publicClientId = await resolvePublicClientId(app);
  const config = await getAppBillingConfig(app.id);
  const billingMode = normalizeBillingMode(config?.billingMode);
  const endUserCap = config?.endUserCap ?? platformDefaultEndUserCap();
  const connectReady = isConnectReady(config);

  // Only *active* identities consume a cap slot. Soft-deactivated (`inactive`)
  // rows stay for audit/billing history but free capacity for new provisioning.
  const [{ value: appUserCount }] = await db
    .select({ value: count() })
    .from(appUsers)
    .where(and(eq(appUsers.clientId, app.id), eq(appUsers.status, "active")));

  const isPlatformDefault = app.isPlatformDefault === 1;
  let canProvisionEndUsers = isPlatformDefault;
  let provisionReason: ActivationReason | null = null;

  if (!isPlatformDefault) {
    const billable = await isOwnerBillable({
      publicClientId,
      ownerId: app.ownerId,
    });
    if (!billable) {
      canProvisionEndUsers = false;
      provisionReason = "owner_payment_method_required";
    } else if (Number(appUserCount) >= endUserCap) {
      canProvisionEndUsers = false;
      provisionReason = "end_user_cap_reached";
    } else {
      canProvisionEndUsers = true;
    }
  }

  const canSellPaidPlans = billingMode === "merchant" && connectReady;
  let sellReason: ActivationReason | null = null;
  if (!canSellPaidPlans) {
    const hasAccount = Boolean(config?.stripeConnectedAccountId?.trim());
    if (billingMode !== "merchant" || !hasAccount) {
      sellReason = "stripe_connect_required";
    } else {
      sellReason = "stripe_connect_pending";
    }
  }

  const reason = pickActivationReason({
    canProvisionEndUsers,
    provisionReason,
    canSellPaidPlans,
    sellReason,
  });

  return {
    clientId: publicClientId,
    billingMode,
    connectReady,
    canProvisionEndUsers,
    canSellPaidPlans,
    reason,
    endUserCap,
    appUserCount: Number(appUserCount),
  };
}

function pickActivationReason(input: {
  canProvisionEndUsers: boolean;
  provisionReason: ActivationReason | null;
  canSellPaidPlans: boolean;
  sellReason: ActivationReason | null;
}): ActivationReason | null {
  if (!input.canProvisionEndUsers) {
    return input.provisionReason;
  }
  if (!input.canSellPaidPlans) {
    return input.sellReason;
  }
  return null;
}

async function markActivationNotified(appId: string): Promise<void> {
  const config = await getAppBillingConfig(appId);
  if (config?.activationNotifiedAt) {
    return;
  }
  await upsertAppBillingConfig(appId, {
    activationNotifiedAt: new Date().toISOString(),
  });
}

async function existingAppUserStatus(
  appId: string,
  externalUserId: string,
): Promise<string | null> {
  const rows = await db
    .select({ status: appUsers.status })
    .from(appUsers)
    .where(
      and(eq(appUsers.clientId, appId), eq(appUsers.externalUserId, externalUserId)),
    )
    .limit(1);
  return rows[0]?.status ?? null;
}

/** True when activating a priced (non-starter) plan requires canSellPaidPlans. */
export function planRequiresSellGate(input: {
  status: string;
  priceAmount: string;
  isStarterDefault?: boolean | null;
}): boolean {
  if (input.isStarterDefault) return false;
  if (input.status !== "active") return false;
  const amount = Number(input.priceAmount);
  return Number.isFinite(amount) && amount > 0;
}

/**
 * Cost-rail assert for consuming an active end-user slot.
 *
 * - Already-`active` rows always pass (idempotent mint / key / allowance paths).
 * - Missing rows (create) and `activating: true` for inactive→active must have
 *   free cap capacity.
 * - Inactive rows without `activating` pass so billing ensure / upserts that do
 *   not reclaim a slot stay ungated.
 */
export async function assertAppCanProvisionUsers(
  clientId: string,
  options: { externalUserId: string; activating?: boolean },
): Promise<AppActivation> {
  const app = await getProviderApp(clientId);
  if (!app) {
    throw new Error(`Unknown app: ${clientId}`);
  }

  const externalUserId = options.externalUserId.trim();
  const existingStatus = externalUserId
    ? await existingAppUserStatus(app.id, externalUserId)
    : null;

  if (existingStatus === "active") {
    return resolveAppActivation(clientId);
  }
  if (existingStatus != null && !options.activating) {
    return resolveAppActivation(clientId);
  }

  const activation = await resolveAppActivation(clientId);
  if (activation.canProvisionEndUsers) {
    return activation;
  }

  const reason: ActivationReason =
    activation.reason === "end_user_cap_reached"
      ? "end_user_cap_reached"
      : "owner_payment_method_required";

  throw new AppActivationError({
    code: reason,
    message: messageForReason(reason),
    status: statusForReason(reason),
    billingMode: activation.billingMode,
    actionUrl: actionUrlForReason(reason, activation.clientId),
    activation: { ...activation, reason },
  });
}

export async function assertAppCanSellPaidPlans(clientId: string): Promise<AppActivation> {
  const app = await getProviderApp(clientId);
  if (!app) {
    throw new Error(`Unknown app: ${clientId}`);
  }

  const activation = await resolveAppActivation(clientId);
  if (activation.canSellPaidPlans) {
    return activation;
  }

  const config = await getAppBillingConfig(app.id);
  const hasAccount = Boolean(config?.stripeConnectedAccountId?.trim());
  const reason: ActivationReason =
    activation.billingMode !== "merchant" || !hasAccount
      ? "stripe_connect_required"
      : "stripe_connect_pending";

  throw new AppActivationError({
    code: reason,
    message: messageForReason(reason),
    status: 403,
    billingMode: activation.billingMode,
    actionUrl: actionUrlForReason(reason, activation.clientId),
    activation: { ...activation, reason },
  });
}

function shouldEnforce(kind: ActivationGateKind, mode: ActivationGateMode): boolean {
  if (mode === "enforce") return true;
  if (mode === "enforce_revenue") return kind === "sell_paid_plans";
  return false;
}

async function evaluateActivationGate(
  kind: ActivationGateKind,
  clientId: string,
  options?: { externalUserId?: string; activating?: boolean },
): Promise<AppActivation> {
  if (kind === "provision") {
    const externalUserId = options?.externalUserId?.trim();
    if (!externalUserId) {
      throw new Error("externalUserId is required for provision gate");
    }
    return assertAppCanProvisionUsers(clientId, {
      externalUserId,
      activating: options?.activating,
    });
  }
  return assertAppCanSellPaidPlans(clientId);
}

async function handleActivationDenial(input: {
  err: AppActivationError;
  kind: ActivationGateKind;
  mode: ActivationGateMode;
}): Promise<AppActivation> {
  const { err, kind, mode } = input;
  // activation.clientId is the public OIDC client id; auth_audit_log.client_id
  // FKs developer_apps.id.
  const app = await getProviderApp(err.activation.clientId);
  const enforced = shouldEnforce(kind, mode);
  await writeAuditLog({
    clientId: app?.id ?? null,
    action: "activation_gate_would_deny",
    // "denied" only when this kind is actually enforced for the mode —
    // enforce_revenue soft-allows provision denials, so those stay "logged".
    status: enforced ? "denied" : "logged",
    metadata: {
      kind,
      mode,
      code: err.code,
      billingMode: err.billingMode,
      reason: err.activation.reason,
      endUserCap: err.activation.endUserCap,
      appUserCount: err.activation.appUserCount,
      publicClientId: err.activation.clientId,
    },
  });

  if (!enforced) {
    return err.activation;
  }

  if (kind === "provision" && app) {
    await markActivationNotified(app.id);
  }

  throw err;
}

async function evaluateSoft(
  kind: ActivationGateKind,
  clientId: string,
  options?: { externalUserId?: string; activating?: boolean },
): Promise<AppActivation> {
  try {
    return await evaluateActivationGate(kind, clientId, options);
  } catch (err) {
    if (err instanceof AppActivationError) {
      return err.activation;
    }
    throw err;
  }
}

/**
 * Central gate runner: off / log / enforce_revenue / enforce.
 * Returns activation when allowed (or when soft modes skip denial).
 *
 * Pass `activating: true` when an existing inactive identity is being restored
 * to `active` so the end-user cap is enforced for the reclaimed slot.
 */
export async function runActivationGate(
  kind: ActivationGateKind,
  clientId: string,
  options?: { externalUserId?: string; activating?: boolean },
): Promise<AppActivation> {
  const mode = getActivationGateMode();
  if (mode === "off") {
    return evaluateSoft(kind, clientId, options);
  }

  try {
    return await evaluateActivationGate(kind, clientId, options);
  } catch (err) {
    if (!(err instanceof AppActivationError)) {
      throw err;
    }
    return handleActivationDenial({ err, kind, mode });
  }
}

/** Test helper: read default cap constant. */
export const __testDefaultEndUserCap = DEFAULT_END_USER_CAP;
