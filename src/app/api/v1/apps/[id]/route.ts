import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import {
  appAllowedDomains,
  appBillingOracleConfig,
  developerApps,
  oidcClients,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  demotePublicClientWhenM2mSiblingExists,
  ensureM2mBackendClient,
  loadM2mOidcClientSummary,
  removeM2mBackendClient,
  syncBackendM2mAllowedScopesFromPublicApp,
  updateClientConfig,
} from "@/lib/oidc/clients";
import { resetProvider } from "@/lib/oidc/provider";
import { DEFAULT_OIDC_SCOPES, OIDC_SCOPES } from "@/lib/oidc/scopes";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  getProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { syncPublicClientGrantTypes } from "@/lib/oidc/grants";
import { deleteDeveloperAppAndRelatedData } from "@/lib/delete-developer-app";
import { billingPatternFromAllowedScopesString } from "@/lib/allowed-scopes";
import { authenticateAppClient } from "@/lib/auth";
import {
  listAvailableFiatOracleProviders,
  resolveBillingOracleProviderKey,
} from "@/lib/prices/fiat-oracle-registry";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function loadPublicOidcClientInfo(app: {
  oidcClientId: string | null;
  m2mOidcClientId: string | null;
}) {
  if (!app.oidcClientId) {
    return null;
  }
  const clientRowsGet = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientId))
    .limit(1);
  const client = clientRowsGet[0];
  if (!client) {
    return null;
  }
  return {
    clientId: client.clientId,
    redirectUris: JSON.parse(client.redirectUris) as string[],
    allowedScopes: client.allowedScopes,
    grantTypes: client.grantTypes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    // Public app_ row must never report a secret when a confidential m2m_ sibling exists.
    hasSecret: app.m2mOidcClientId
      ? false
      : client.tokenEndpointAuthMethod !== "none" &&
        !!client.clientSecretHash,
    postLogoutRedirectUris: client.postLogoutRedirectUris
      ? (JSON.parse(client.postLogoutRedirectUris) as string[])
      : [],
    initiateLoginUri: client.initiateLoginUri,
    deviceThirdPartyInitiateLogin: client.deviceThirdPartyInitiateLogin === 1,
    logoUri: client.logoUri,
    policyUri: client.policyUri,
    tosUri: client.tosUri,
    clientUri: client.clientUri,
  };
}

async function loadM2mOidcClientSummaryForApp(m2mOidcClientId: string | null) {
  if (!m2mOidcClientId) {
    return null;
  }
  const m2mRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, m2mOidcClientId))
    .limit(1);
  const m2m = m2mRows[0];
  if (!m2m) {
    return null;
  }
  return {
    clientId: m2m.clientId,
    hasSecret: !!m2m.clientSecretHash,
  };
}

async function getAppForClientAuth(clientId: string, request: NextRequest): Promise<
  | { kind: "ok"; publicClientId: string; app: NonNullable<Awaited<ReturnType<typeof getProviderApp>>>; allowedScopes: string }
  | { kind: "notfound" }
  | null
> {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId !== clientId) {
    return null;
  }
  const app = await getProviderApp(clientId);
  if (!app) {
    return { kind: "notfound" };
  }
  let allowedScopes = DEFAULT_OIDC_SCOPES;
  if (app.oidcClientId) {
    const clientRows = await db
      .select({ allowedScopes: oidcClients.allowedScopes })
      .from(oidcClients)
      .where(eq(oidcClients.id, app.oidcClientId))
      .limit(1);
    allowedScopes = clientRows[0]?.allowedScopes ?? DEFAULT_OIDC_SCOPES;
  }
  return { kind: "ok", publicClientId: clientAuth.appId, app, allowedScopes };
}

async function upsertBillingOracleConfig(
  appId: string,
  body: Record<string, unknown>,
  now: string,
): Promise<NextResponse | null> {
  const hasBillingUpdate =
    body.billingDisplayCurrency !== undefined ||
    body.billingOracleProviderKey !== undefined ||
    body.billingOracleProviderConfig !== undefined;
  if (!hasBillingUpdate) {
    return null;
  }

  const existingPricingRows = await db
    .select()
    .from(appBillingOracleConfig)
    .where(eq(appBillingOracleConfig.clientId, appId))
    .limit(1)
    .catch(() => []);
  const existingPricing = existingPricingRows[0] ?? null;
  const nextCurrency =
    body.billingDisplayCurrency !== undefined
      ? String(body.billingDisplayCurrency || "USD").toUpperCase()
      : (existingPricing?.billingDisplayCurrency ?? "USD");
  if (nextCurrency !== "USD") {
    return NextResponse.json(
      { error: "billingDisplayCurrency must be USD" },
      { status: 400 },
    );
  }
  const nextProvider = resolveBillingOracleProviderKey(
    body.billingOracleProviderKey !== undefined
      ? String(body.billingOracleProviderKey)
      : (existingPricing?.billingOracleProviderKey ?? "global_eth_usd"),
  ).key;
  const nextConfig =
    body.billingOracleProviderConfig !== undefined
      ? (body.billingOracleProviderConfig &&
        typeof body.billingOracleProviderConfig === "object"
          ? (body.billingOracleProviderConfig as Record<string, unknown>)
          : null)
      : (existingPricing?.billingOracleProviderConfig ?? null);
  if (existingPricing) {
    await db
      .update(appBillingOracleConfig)
      .set({
        billingDisplayCurrency: nextCurrency,
        billingOracleProviderKey: nextProvider,
        billingOracleProviderConfig: nextConfig,
        updatedAt: now,
      })
      .where(eq(appBillingOracleConfig.id, existingPricing.id));
  } else {
    await db.insert(appBillingOracleConfig).values({
      id: uuidv4(),
      clientId: appId,
      billingDisplayCurrency: nextCurrency,
      billingOracleProviderKey: nextProvider,
      billingOracleProviderConfig: nextConfig,
      createdAt: now,
      updatedAt: now,
    });
  }
  return null;
}

function buildOidcClientUpdates(
  body: Record<string, unknown>,
  client: typeof oidcClients.$inferSelect,
): Parameters<typeof updateClientConfig>[1] {
  const clientUpdates: Parameters<typeof updateClientConfig>[1] = {};
  if (body.name) clientUpdates.displayName = body.name as string;
  if (body.redirectUris) clientUpdates.redirectUris = body.redirectUris as string[];
  if (body.tokenEndpointAuthMethod) {
    clientUpdates.tokenEndpointAuthMethod =
      body.tokenEndpointAuthMethod as "none" | "client_secret_post" | "client_secret_basic";
  }
  if (body.allowedScopes) {
    const validScopeValues = new Set(OIDC_SCOPES.map((s) => s.value));
    const filtered = String(body.allowedScopes)
      .split(/[,\s]+/)
      .filter((s) => s && validScopeValues.has(s))
      .join(" ");
    clientUpdates.allowedScopes = filtered || DEFAULT_OIDC_SCOPES;
  }
  if (body.grantTypes) clientUpdates.grantTypes = body.grantTypes as string[];

  // Resolve the final redirect URIs (updated or unchanged) and enforce the
  // authorization_code ↔ redirect_uris invariant on every write.
  const finalRedirectUris =
    clientUpdates.redirectUris ??
    (JSON.parse(client.redirectUris) as string[]);
  const baseGrants =
    clientUpdates.grantTypes ?? client.grantTypes.split(",").filter(Boolean);
  clientUpdates.grantTypes = syncPublicClientGrantTypes(
    baseGrants,
    finalRedirectUris,
    client.clientId,
  );

  const nextGrantTypes = clientUpdates.grantTypes;
  const nextInitiateLoginUri = client.initiateLoginUri?.trim();
  const nextDeviceThirdPartyInitiateLogin = client.deviceThirdPartyInitiateLogin === 1;
  if (
    nextDeviceThirdPartyInitiateLogin &&
    nextInitiateLoginUri &&
    nextGrantTypes.includes(DEVICE_CODE_GRANT)
  ) {
    const allowedScopes = (
      clientUpdates.allowedScopes ?? client.allowedScopes
    )
      .split(/[,\s]+/)
      .filter(Boolean);
    if (!allowedScopes.includes("users:token")) {
      clientUpdates.allowedScopes = [...allowedScopes, "users:token"].join(" ");
    }
  }
  return clientUpdates;
}

async function applyPublicOidcClientUpdates(
  app: { id: string; oidcClientId: string | null; m2mOidcClientId: string | null },
  body: Record<string, unknown>,
) {
  if (!app.oidcClientId) {
    return;
  }
  const clientRowsPut = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientId))
    .limit(1);
  const client = clientRowsPut[0];
  if (!client) {
    return;
  }

  const clientUpdates = buildOidcClientUpdates(body, client);
  if (Object.keys(clientUpdates).length > 0) {
    await updateClientConfig(client.clientId, clientUpdates);
    resetProvider();
  }

  if (app.m2mOidcClientId && (await demotePublicClientWhenM2mSiblingExists(app.id))) {
    resetProvider();
  }
}

async function applyBackendDeviceHelper(
  app: { id: string; name: string },
  body: Record<string, unknown>,
) {
  if (body.backendDeviceHelper === false) {
    if (await removeM2mBackendClient(app.id)) {
      resetProvider();
    }
    return;
  }
  if (body.backendDeviceHelper !== true) {
    return;
  }
  await ensureM2mBackendClient({
    appInternalId: app.id,
    appDisplayName:
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : app.name,
  });
  if (await demotePublicClientWhenM2mSiblingExists(app.id)) {
    resetProvider();
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const clientAuthPayload = await getAppForClientAuth(clientId, request);
  if (clientAuthPayload?.kind === "notfound") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (clientAuthPayload?.kind === "ok") {
    const { publicClientId, app, allowedScopes } = clientAuthPayload;
    return NextResponse.json({
      clientId: publicClientId,
      name: app.name,
      status: app.status,
      billingPattern: billingPatternFromAllowedScopesString(allowedScopes),
      allowedScopes,
      links: {
        manifest: `/api/v1/apps/${encodeURIComponent(publicClientId)}/manifest`,
      },
    });
  }

  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { app } = auth;
  const clientInfo = await loadPublicOidcClientInfo(app);
  const m2mOidcClient = await loadM2mOidcClientSummaryForApp(app.m2mOidcClientId);

  const domains = await db
    .select()
    .from(appAllowedDomains)
    .where(eq(appAllowedDomains.appId, app.id));
  const pricingRows = await db
    .select()
    .from(appBillingOracleConfig)
    .where(eq(appBillingOracleConfig.clientId, app.id))
    .limit(1)
    .catch(() => []);
  const pricing = pricingRows[0] ?? null;

  const canonicalClientId = clientInfo?.clientId ?? clientId;
  const { oidcClientId: _oidcClientId, ...appWithoutOidcClientId } = app;
  const billingPattern = clientInfo
    ? billingPatternFromAllowedScopesString(
        clientInfo.allowedScopes ?? DEFAULT_OIDC_SCOPES,
      )
    : "app_level";
  return NextResponse.json({
    ...appWithoutOidcClientId,
    billingPattern,
    id: canonicalClientId,
    clientId: canonicalClientId,
    canEdit: await canEditProviderApp(auth),
    canDeleteApp: auth.app.ownerId === auth.userId,
    canManageBilling: auth.app.ownerId === auth.userId || auth.role === "admin",
    oidcClient: clientInfo
      ? {
          ...clientInfo,
          allowedScopes: clientInfo.allowedScopes ?? DEFAULT_OIDC_SCOPES,
        }
      : null,
    m2mOidcClient,
    domains,
    usagePricing: {
      billingDisplayCurrency: pricing?.billingDisplayCurrency ?? "USD",
      billingOracleProviderKey: pricing?.billingOracleProviderKey ?? "global_eth_usd",
      billingOracleProviderConfig: pricing?.billingOracleProviderConfig ?? null,
      availableOracleProviders: listAvailableFiatOracleProviders(),
    },
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const { app } = auth;
  const body = await request.json();

  const now = new Date().toISOString();

  const appUpdates: Record<string, unknown> = { updatedAt: now };
  const appFields = [
    "name",
    "description",
    "developerName",
    "websiteUrl",
  ] as const;

  for (const field of appFields) {
    if (body[field] !== undefined) {
      appUpdates[field] = body[field];
    }
  }

  await db.update(developerApps).set(appUpdates).where(eq(developerApps.id, app.id));

  const billingErr = await upsertBillingOracleConfig(app.id, body, now);
  if (billingErr) {
    return billingErr;
  }

  // Provider apps are self-service in the MVP, so OIDC config updates apply immediately.
  await applyPublicOidcClientUpdates(app, body);
  await applyBackendDeviceHelper(app, body);

  if (await syncBackendM2mAllowedScopesFromPublicApp(app.id)) {
    resetProvider();
  }

  const m2mAfter = await loadM2mOidcClientSummary(app.id);

  return NextResponse.json({ success: true, m2mOidcClient: m2mAfter });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (auth.app.ownerId !== auth.userId) {
    return NextResponse.json(
      { error: "Only the app owner can delete this app." },
      { status: 403 },
    );
  }

  await deleteDeveloperAppAndRelatedData(auth.app.id, auth.app.oidcClientId ?? null);

  return new NextResponse(null, { status: 204 });
}
