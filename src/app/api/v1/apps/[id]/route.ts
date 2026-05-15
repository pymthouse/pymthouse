import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { developerApps, oidcClients, appAllowedDomains } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  ensureM2mBackendClient,
  syncBackendM2mAllowedScopesFromPublicApp,
  updateClientConfig,
} from "@/lib/oidc/clients";
import { resetProvider } from "@/lib/oidc/provider";
import { DEFAULT_OIDC_SCOPES, OIDC_SCOPES } from "@/lib/oidc/scopes";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { deleteDeveloperAppAndRelatedData } from "@/lib/delete-developer-app";
import { billingPatternFromAllowedScopesString } from "@/lib/allowed-scopes";
import {
  SIGNING_MODE_LEGACY_REMOTE_SIGNER,
  SIGNING_MODE_LPNM_PAYER_DAEMON,
} from "@/lib/signing-modes";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
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
        hasSecret: !!client.clientSecretHash,
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
    oidcClient: clientInfo
      ? {
          ...clientInfo,
          allowedScopes: clientInfo.allowedScopes ?? DEFAULT_OIDC_SCOPES,
        }
      : null,
    m2mOidcClient,
    domains,
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

  if (body.signingMode !== undefined) {
    const m = String(body.signingMode);
    if (m !== SIGNING_MODE_LEGACY_REMOTE_SIGNER && m !== SIGNING_MODE_LPNM_PAYER_DAEMON) {
      return NextResponse.json(
        {
          error: `Invalid signingMode (expected ${SIGNING_MODE_LEGACY_REMOTE_SIGNER} or ${SIGNING_MODE_LPNM_PAYER_DAEMON})`,
        },
        { status: 400 },
      );
    }
    appUpdates.signingMode = m;
  }
  if (body.payerDaemonSocket !== undefined) {
    const raw = body.payerDaemonSocket;
    if (raw === null || raw === "") {
      appUpdates.payerDaemonSocket = null;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length > 512) {
        return NextResponse.json(
          { error: "payerDaemonSocket must be at most 512 characters" },
          { status: 400 },
        );
      }
      appUpdates.payerDaemonSocket = trimmed || null;
    } else {
      return NextResponse.json(
        { error: "payerDaemonSocket must be a string or null" },
        { status: 400 },
      );
    }
  }

  await db.update(developerApps).set(appUpdates).where(eq(developerApps.id, app.id));

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

      const nextGrantTypes = (
        clientUpdates.grantTypes ?? client.grantTypes.split(",").filter(Boolean)
      );
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
    }
  }

  let m2mAfter: { clientId: string; hasSecret: boolean } | null = null;
  if (body.backendDeviceHelper === true) {
    await ensureM2mBackendClient({
      appInternalId: app.id,
      appDisplayName: typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : app.name,
    });
    resetProvider();
    const refreshed = await db
      .select({ m2mOidcClientId: developerApps.m2mOidcClientId })
      .from(developerApps)
      .where(eq(developerApps.id, app.id))
      .limit(1);
    const m2mPk = refreshed[0]?.m2mOidcClientId;
    if (m2mPk) {
      const m2mRows = await db
        .select()
        .from(oidcClients)
        .where(eq(oidcClients.id, m2mPk))
        .limit(1);
      const m2m = m2mRows[0];
      if (m2m) {
        m2mAfter = {
          clientId: m2m.clientId,
          hasSecret: !!m2m.clientSecretHash,
        };
      }
    }
  }

  if (await syncBackendM2mAllowedScopesFromPublicApp(app.id)) {
    resetProvider();
  }

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
