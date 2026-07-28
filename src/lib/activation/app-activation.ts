import { and, count, eq } from "drizzle-orm";

import { writeAuditLog } from "@/lib/audit";
import { db } from "@/db/index";
import { appUsers, developerApps, oidcClients } from "@/db/schema";
import { hasPositiveUsdMicrosBalance } from "@/lib/format-usd-micros";
import { getAppBillingConfig, upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { getSpendableUsdMicros } from "@/lib/openmeter/spendable-allowance";
import { getProviderApp } from "@/lib/provider-apps";

export type BillingMode = "owner_rollup" | "merchant";

export type ActivationReason =
  | "owner_balance_exhausted"
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

const DEFAULT_END_USER_CAP = 25;

type SpendableLookup = typeof getSpendableUsdMicros;
let spendableLookup: SpendableLookup = getSpendableUsdMicros;

/** Test-only override for owner solvency lookups. */
export function __testSetSpendableLookup(fn: SpendableLookup | null): void {
  spendableLookup = fn ?? getSpendableUsdMicros;
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

function appSettingsActionUrl(publicClientId: string): string {
  const base = (process.env.NEXTAUTH_URL || "http://localhost:3001").replace(/\/$/, "");
  return `${base}/apps/${encodeURIComponent(publicClientId)}/settings?tab=billing`;
}

function messageForReason(reason: ActivationReason): string {
  switch (reason) {
    case "owner_balance_exhausted":
      return "Owner wallet has no spendable balance";
    case "end_user_cap_reached":
      return "App end-user cap reached";
    case "stripe_connect_required":
      return "Stripe Connect is required to sell paid plans";
    case "stripe_connect_pending":
      return "Stripe Connect onboarding is incomplete";
  }
}

function statusForReason(reason: ActivationReason): number {
  return reason === "owner_balance_exhausted" ? 402 : 403;
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
  const endUserCap = config?.endUserCap ?? DEFAULT_END_USER_CAP;
  const connectReady = isConnectReady(config);

  const [{ value: appUserCount }] = await db
    .select({ value: count() })
    .from(appUsers)
    .where(eq(appUsers.clientId, app.id));

  const isPlatformDefault = app.isPlatformDefault === 1;
  let canProvisionEndUsers = isPlatformDefault;
  let provisionReason: ActivationReason | null = null;

  if (!isPlatformDefault) {
    const spendable = await spendableLookup({
      clientId: publicClientId,
      externalUserId: app.ownerId,
    });
    // Fail-open when OpenMeter is unavailable (null) so outages do not freeze provisioning.
    const solvent = spendable == null || hasPositiveUsdMicrosBalance(spendable);
    if (!solvent) {
      canProvisionEndUsers = false;
      provisionReason = "owner_balance_exhausted";
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

  const reason = !canProvisionEndUsers
    ? provisionReason
    : !canSellPaidPlans
      ? sellReason
      : null;

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

async function markActivationNotified(appId: string): Promise<void> {
  const config = await getAppBillingConfig(appId);
  if (config?.activationNotifiedAt) {
    return;
  }
  await upsertAppBillingConfig(appId, {
    activationNotifiedAt: new Date().toISOString(),
  });
}

async function existingAppUser(
  appId: string,
  externalUserId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(
      and(eq(appUsers.clientId, appId), eq(appUsers.externalUserId, externalUserId)),
    )
    .limit(1);
  return Boolean(rows[0]);
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
 * Creation-only cost-rail assert. Existing app_users always pass.
 */
export async function assertAppCanProvisionUsers(
  clientId: string,
  options: { externalUserId: string },
): Promise<AppActivation> {
  const app = await getProviderApp(clientId);
  if (!app) {
    throw new Error(`Unknown app: ${clientId}`);
  }

  const externalUserId = options.externalUserId.trim();
  if (externalUserId && (await existingAppUser(app.id, externalUserId))) {
    return resolveAppActivation(clientId);
  }

  const activation = await resolveAppActivation(clientId);
  if (activation.canProvisionEndUsers) {
    return activation;
  }

  const reason: ActivationReason =
    activation.reason === "end_user_cap_reached"
      ? "end_user_cap_reached"
      : "owner_balance_exhausted";

  throw new AppActivationError({
    code: reason,
    message: messageForReason(reason),
    status: statusForReason(reason),
    billingMode: activation.billingMode,
    actionUrl: appSettingsActionUrl(activation.clientId),
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
    actionUrl: appSettingsActionUrl(activation.clientId),
    activation: { ...activation, reason },
  });
}

function shouldEnforce(kind: ActivationGateKind, mode: ActivationGateMode): boolean {
  if (mode === "enforce") return true;
  if (mode === "enforce_revenue") return kind === "sell_paid_plans";
  return false;
}

/**
 * Central gate runner: off / log / enforce_revenue / enforce.
 * Returns activation when allowed (or when soft modes skip denial).
 */
export async function runActivationGate(
  kind: ActivationGateKind,
  clientId: string,
  options?: { externalUserId?: string },
): Promise<AppActivation> {
  const mode = getActivationGateMode();

  const evaluate = async (): Promise<AppActivation> => {
    if (kind === "provision") {
      const externalUserId = options?.externalUserId?.trim();
      if (!externalUserId) {
        throw new Error("externalUserId is required for provision gate");
      }
      return assertAppCanProvisionUsers(clientId, { externalUserId });
    }
    return assertAppCanSellPaidPlans(clientId);
  };

  if (mode === "off") {
    // Still resolve for callers that want visibility; never deny.
    try {
      return await evaluate();
    } catch (err) {
      if (err instanceof AppActivationError) {
        return err.activation;
      }
      throw err;
    }
  }

  try {
    return await evaluate();
  } catch (err) {
    if (!(err instanceof AppActivationError)) {
      throw err;
    }

    await writeAuditLog({
      clientId: err.activation.clientId,
      action: "activation_gate_would_deny",
      status: mode === "log" ? "logged" : "denied",
      metadata: {
        kind,
        mode,
        code: err.code,
        billingMode: err.billingMode,
        reason: err.activation.reason,
        endUserCap: err.activation.endUserCap,
        appUserCount: err.activation.appUserCount,
      },
    });

    if (!shouldEnforce(kind, mode)) {
      return err.activation;
    }

    if (kind === "provision") {
      const notifiedApp = await getProviderApp(clientId);
      if (notifiedApp) {
        await markActivationNotified(notifiedApp.id);
      }
    }

    throw err;
  }
}

/** Test helper: read default cap constant. */
export const __testDefaultEndUserCap = DEFAULT_END_USER_CAP;
