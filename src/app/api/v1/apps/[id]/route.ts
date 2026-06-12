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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const app = await getProviderApp(clientId);
    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
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
    const publicClientId = clientAuth.appId;
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

  let clientInfo = null;
  let m2mOidcClient: {
    clientId: string;
    hasSecret: boolean;
  } | null = null;
  if (app.oidcClientId) {
    const clientRowsGet = await db
      .select()
      .from(oidcClients)
      .where(eq(oidcClients.id, app.oidcClientId))
      .limit(1);
    const client = clientRowsGet[0];

    if (client) {
      clientInfo = {
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
  }

  if (app.m2mOidcClientId) {
    const m2mRows = await db
      .select()
      .from(oidcClients)
      .where(eq(oidcClients.id, app.m2mOidcClientId))
      .limit(1);
    const m2m = m2mRows[0];
    if (m2m) {
      m2mOidcClient = {
        clientId: m2m.clientId,
        hasSecret: !!m2m.clientSecretHash,
      };
    }
  }

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
    canSubmitForReview: auth.app.ownerId === auth.userId,
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

  if (
    body.billingDisplayCurrency !== undefined ||
    body.billingOracleProviderKey !== undefined ||
    body.billingOracleProviderConfig !== undefined
  ) {
    const existingPricingRows = await db
      .select()
      .from(appBillingOracleConfig)
      .where(eq(appBillingOracleConfig.clientId, app.id))
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
            ? body.billingOracleProviderConfig
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
        clientId: app.id,
        billingDisplayCurrency: nextCurrency,
        billingOracleProviderKey: nextProvider,
        billingOracleProviderConfig: nextConfig,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Provider apps are self-service in the MVP, so OIDC config updates apply immediately.
  if (app.oidcClientId) {
    const clientRowsPut = await db
      .select()
      .from(oidcClients)
      .where(eq(oidcClients.id, app.oidcClientId))
      .limit(1);
    const client = clientRowsPut[0];

    if (client) {
      const clientUpdates: Parameters<typeof updateClientConfig>[1] = {};
      if (body.name) clientUpdates.displayName = body.name;
      if (body.redirectUris) clientUpdates.redirectUris = body.redirectUris;
      if (body.tokenEndpointAuthMethod)
        clientUpdates.tokenEndpointAuthMethod = body.tokenEndpointAuthMethod;
      if (body.allowedScopes) {
        const validScopeValues = new Set(OIDC_SCOPES.map((s) => s.value));
        const filtered = String(body.allowedScopes)
          .split(/[,\s]+/)
          .filter((s) => s && validScopeValues.has(s))
          .join(" ");
        clientUpdates.allowedScopes = filtered || DEFAULT_OIDC_SCOPES;
      }
      if (body.grantTypes) clientUpdates.grantTypes = body.grantTypes;

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

      if (Object.keys(clientUpdates).length > 0) {
        await updateClientConfig(client.clientId, clientUpdates);
        resetProvider();
      }

      if (app.m2mOidcClientId && (await demotePublicClientWhenM2mSiblingExists(app.id))) {
        resetProvider();
      }
    }
  }

  if (body.backendDeviceHelper === false) {
    if (await removeM2mBackendClient(app.id)) {
      resetProvider();
    }
  } else if (body.backendDeviceHelper === true) {
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

  if (auth.app.status !== "draft") {
    return NextResponse.json(
      { error: "Only draft apps can be deleted." },
      { status: 400 },
    );
  }

  await deleteDeveloperAppAndRelatedData(auth.app.id, auth.app.oidcClientId ?? null);

  return new NextResponse(null, { status: 204 });
}
