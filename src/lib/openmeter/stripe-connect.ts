import { eq, and, lt } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appBillingConfig, appBillingOauthStates } from "@/db/schema";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { getDefaultBillingProfileId } from "./constants";
import { ensureTenantBillingProfile, upsertAppBillingConfig } from "./billing-profiles";
import { assignCustomerBillingProfileOverride, listTenantCustomerIds } from "./customers";

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

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

  const install = await client.apps.marketplace.getOauth2InstallUrl("stripe");

  if (!install?.url) {
    throw new Error("OpenMeter Stripe OAuth install URL unavailable");
  }

  return { state, url: install.url };
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

  const profileId = await ensureTenantBillingProfile({
    clientId: input.clientId,
    openmeterStripeAppId: stripeApp.id,
  });

  await upsertAppBillingConfig(input.clientId, {
    stripeConnectStatus: "connected",
    openmeterStripeAppId: stripeApp.id,
    openmeterBillingProfileId: profileId,
    connectedAt: now,
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

  // Re-point all existing tenant customers to the platform default billing
  // profile (e.g. sandbox) so future starter subscription creates don't fail
  // with a Stripe precondition error against the namespace default profile.
  const defaultProfileId = getDefaultBillingProfileId();
  if (defaultProfileId && isHostedAdminClientAvailable()) {
    try {
      const client = getHostedAdminClient();
      const customerIds = await listTenantCustomerIds(client, clientId);
      await Promise.all(
        customerIds.map((id) =>
          assignCustomerBillingProfileOverride({
            client,
            customerId: id,
            billingProfileId: defaultProfileId,
          }).catch(() => undefined),
        ),
      );
    } catch {
      /* best effort — disconnect still completes */
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
