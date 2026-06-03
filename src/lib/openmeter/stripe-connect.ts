import { eq, and, lt } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appBillingConfig, appBillingOauthStates } from "@/db/schema";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";
import { getHostedAdminClient } from "./admin-client";
import {
  ensureTenantBillingProfile,
  getAppBillingConfig,
  upsertAppBillingConfig,
} from "./billing-profiles";
import { isOpenMeterConflictError } from "./plan-errors";
import type { OpenMeter } from "@openmeter/sdk";

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function stripeConnectCallbackUrl(clientId: string): string {
  return `${getPublicOrigin()}/api/v1/apps/${encodeURIComponent(clientId)}/billing/stripe/callback`;
}

/** Attach pymthouse callback + CSRF state to OpenMeter's Stripe Connect install URL. */
export function buildStripeConnectInstallUrl(input: {
  installUrl: string;
  clientId: string;
  state: string;
}): string {
  const url = new URL(input.installUrl);
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", stripeConnectCallbackUrl(input.clientId));
  return url.toString();
}

export class StripeOAuthUnavailableError extends Error {
  constructor() {
    super("Stripe OAuth is not available on this OpenMeter deployment");
    this.name = "StripeOAuthUnavailableError";
  }
}

function openMeterErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function isOpenMeterUnreachable(err: unknown): boolean {
  const message = openMeterErrorMessage(err).toLowerCase();
  const cause = err instanceof Error && "cause" in err ? String(err.cause).toLowerCase() : "";
  return (
    message.includes("econnrefused") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    cause.includes("econnrefused") ||
    cause.includes("enotfound")
  );
}

function isStripeOAuthUnavailable(err: unknown): boolean {
  const message = openMeterErrorMessage(err);
  return message.includes("501") || message.toLowerCase().includes("unimplemented");
}

export function formatOpenMeterBillingError(err: unknown): string {
  if (isOpenMeterUnreachable(err)) {
    const url = process.env.OPENMETER_URL?.trim() || "http://127.0.0.1:48888";
    return (
      `Cannot reach OpenMeter at ${url}. Start local OpenMeter (docker compose -f docker-compose.openmeter.yml up -d) ` +
      "or set OPENMETER_URL and OPENMETER_API_KEY to your Railway instance."
    );
  }
  return formatStripeInstallError(err);
}

function formatStripeInstallError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (isStripeOAuthUnavailable(err)) {
    return (
      "Stripe OAuth is not available on self-hosted OpenMeter. Use a restricted Stripe secret key " +
      "(sk_live_… or sk_test_…) from the merchant account instead."
    );
  }
  return message;
}

async function finalizeStripeAppConnection(input: {
  clientId: string;
  openmeterStripeAppId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const profileId = await ensureTenantBillingProfile({
    clientId: input.clientId,
    openmeterStripeAppId: input.openmeterStripeAppId,
  });
  await upsertAppBillingConfig(input.clientId, {
    stripeConnectStatus: "connected",
    openmeterStripeAppId: input.openmeterStripeAppId,
    openmeterBillingProfileId: profileId,
    connectedAt: now,
  });
}

function stripeAppInstallName(clientId: string): string {
  return `pymthouse-${clientId}`;
}

export function parseStripeAccountIdFromConflict(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/acct_[a-zA-Z0-9]+/);
  return match?.[0] ?? null;
}

async function findExistingStripeAppForTenant(
  client: OpenMeter,
  clientId: string,
  stripeAccountId?: string | null,
): Promise<string | null> {
  const expectedName = stripeAppInstallName(clientId);
  const apps = await client.apps.list({ page: 1, pageSize: 100 });
  const stripeApps = (apps?.items ?? []).filter((app) => app.type === "stripe");

  const byName = stripeApps.find((app) => app.name === expectedName);
  if (byName?.id) {
    return byName.id;
  }

  if (stripeAccountId) {
    const byAccount = stripeApps.find((app) => {
      if (app.type !== "stripe") {
        return false;
      }
      return app.stripeAccountId === stripeAccountId;
    });
    if (byAccount?.id) {
      return byAccount.id;
    }
  }

  return null;
}

async function resolveOrInstallStripeApp(input: {
  client: OpenMeter;
  clientId: string;
  stripeSecretKey: string;
}): Promise<string> {
  const existingConfig = await getAppBillingConfig(input.clientId);
  if (existingConfig?.openmeterStripeAppId) {
    return existingConfig.openmeterStripeAppId;
  }

  try {
    const install = await input.client.apps.marketplace.installWithAPIKey("stripe", {
      apiKey: input.stripeSecretKey,
      name: stripeAppInstallName(input.clientId),
      createBillingProfile: false,
    });
    const appId = install?.app?.id;
    if (!appId) {
      throw new Error("Failed to install Stripe app in OpenMeter");
    }
    return appId;
  } catch (err) {
    if (!isOpenMeterConflictError(err)) {
      throw new Error(formatOpenMeterBillingError(err));
    }
    const accountId = parseStripeAccountIdFromConflict(err);
    const existingId = await findExistingStripeAppForTenant(
      input.client,
      input.clientId,
      accountId,
    );
    if (existingId) {
      return existingId;
    }
    throw new Error(
      "This Stripe account is already connected in OpenMeter but could not be matched to this app. " +
        "Remove the duplicate Stripe app in OpenMeter or contact support.",
    );
  }
}

/** Self-hosted OpenMeter: install Stripe app with the merchant's secret API key. */
export async function connectStripeWithApiKey(input: {
  clientId: string;
  stripeSecretKey: string;
}): Promise<void> {
  const apiKey = input.stripeSecretKey.trim();
  if (!apiKey.startsWith("sk_")) {
    throw new Error("Stripe secret key must start with sk_live_ or sk_test_");
  }

  const client = getHostedAdminClient();
  const appId = await resolveOrInstallStripeApp({
    client,
    clientId: input.clientId,
    stripeSecretKey: apiKey,
  });
  await finalizeStripeAppConnection({
    clientId: input.clientId,
    openmeterStripeAppId: appId,
  });
}

export async function createStripeOAuthState(input: {
  clientId: string;
  userId: string;
}): Promise<{ state: string; url: string }> {
  const client = getHostedAdminClient();
  const state = uuidv4();
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();

  await db.insert(appBillingOauthStates).values({
    id: uuidv4(),
    state,
    clientId: input.clientId,
    userId: input.userId,
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  let install: { url?: string };
  try {
    install = await client.apps.marketplace.getOauth2InstallUrl("stripe");
  } catch (err) {
    if (isOpenMeterUnreachable(err)) {
      throw new Error(formatOpenMeterBillingError(err));
    }
    if (isStripeOAuthUnavailable(err)) {
      throw new StripeOAuthUnavailableError();
    }
    throw new Error(formatStripeInstallError(err));
  }

  if (!install?.url) {
    throw new Error("OpenMeter Stripe OAuth install URL unavailable");
  }

  return {
    state,
    url: buildStripeConnectInstallUrl({
      installUrl: install.url,
      clientId: input.clientId,
      state,
    }),
  };
}

export async function completeStripeOAuthCallback(input: {
  clientId: string;
  state: string;
  userId: string;
  oauthQuery: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const stateRows = await db
    .select()
    .from(appBillingOauthStates)
    .where(
      and(
        eq(appBillingOauthStates.state, input.state),
        eq(appBillingOauthStates.clientId, input.clientId),
        eq(appBillingOauthStates.userId, input.userId),
      ),
    )
    .limit(1);

  const stateRow = stateRows[0];
  if (!stateRow || stateRow.expiresAt < now) {
    throw new Error("Invalid or expired OAuth state");
  }

  const client = getHostedAdminClient();
  const baseUrl = process.env.OPENMETER_URL?.replace(/\/$/, "") || "http://127.0.0.1:48888";
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  const authorizeUrl = `${baseUrl}/api/v1/marketplace/listings/stripe/install/oauth2/authorize?${input.oauthQuery}`;
  const authorizeResp = await fetch(authorizeUrl, {
    method: "GET",
    redirect: "manual",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (authorizeResp.status >= 400) {
    throw new Error(`Stripe OAuth authorize failed (${authorizeResp.status})`);
  }

  const apps = await client.apps.list({ page: 1, pageSize: 100 });
  const stripeApp = (apps?.items ?? []).find((app) => app.type === "stripe");
  if (!stripeApp?.id) {
    throw new Error("Stripe app not found after OAuth authorization");
  }

  await finalizeStripeAppConnection({
    clientId: input.clientId,
    openmeterStripeAppId: stripeApp.id,
  });

  await db.delete(appBillingOauthStates).where(eq(appBillingOauthStates.id, stateRow.id));
}

export async function disconnectStripeConnect(clientId: string): Promise<void> {
  const config = await db
    .select()
    .from(appBillingConfig)
    .where(eq(appBillingConfig.clientId, clientId))
    .limit(1);
  const row = config[0];
  if (row?.openmeterStripeAppId) {
    try {
      const client = getHostedAdminClient();
      await client.apps.uninstall(row.openmeterStripeAppId);
    } catch {
      /* best effort */
    }
  }
  await upsertAppBillingConfig(clientId, {
    stripeConnectStatus: "disconnected",
    openmeterStripeAppId: null,
    openmeterBillingProfileId: null,
    connectedAt: null,
  });
}

export async function purgeExpiredOAuthStates(): Promise<void> {
  const now = new Date().toISOString();
  await db.delete(appBillingOauthStates).where(lt(appBillingOauthStates.expiresAt, now));
}

export async function getStripeConnectStatus(clientId: string) {
  const row = await db
    .select()
    .from(appBillingConfig)
    .where(eq(appBillingConfig.clientId, clientId))
    .limit(1);
  const config = row[0];
  return {
    status: config?.stripeConnectStatus ?? "disconnected",
    openmeterStripeAppId: config?.openmeterStripeAppId ?? null,
    openmeterBillingProfileId: config?.openmeterBillingProfileId ?? null,
    defaultCurrency: config?.defaultCurrency ?? "USD",
    connectedAt: config?.connectedAt ?? null,
  };
}
