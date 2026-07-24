import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/index";
import { oidcClients, appAllowedDomains } from "@/db/schema";
import { eq } from "drizzle-orm";
import { updateClientConfig } from "@/lib/oidc/clients";
import { resetProvider } from "@/lib/oidc/provider";
import { normalizeDomainWhitelist } from "@/lib/domain-whitelist";
import { v4 as uuidv4 } from "uuid";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { validateInitiateLoginUri } from "@/lib/oidc/third-party-initiate-login";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function extractOrigins(uris: string[]): string[] {
  const origins = new Set<string>();
  for (const uri of uris) {
    try {
      const url = new URL(uri);
      origins.add(url.origin);
    } catch {
      /* skip malformed URIs */
    }
  }
  return Array.from(origins);
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
  if (!app.oidcClientId) {
    return NextResponse.json(
      { error: "App has no OIDC client" },
      { status: 400 }
    );
  }

  const clientRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientId))
    .limit(1);
  const client = clientRows[0];

  if (!client) {
    return NextResponse.json(
      { error: "OIDC client not found" },
      { status: 404 }
    );
  }

  const body = await request.json();

  // Build update payload from allowed fields
  const clientUpdates: Parameters<typeof updateClientConfig>[1] = {};

  if (Array.isArray(body.redirectUris)) {
    clientUpdates.redirectUris = body.redirectUris;
  }
  if (Array.isArray(body.postLogoutRedirectUris)) {
    clientUpdates.postLogoutRedirectUris = body.postLogoutRedirectUris;
  }
  if (body.initiateLoginUri !== undefined) {
    clientUpdates.initiateLoginUri = body.initiateLoginUri || null;
  }
  if (body.deviceThirdPartyInitiateLogin !== undefined) {
    clientUpdates.deviceThirdPartyInitiateLogin = Boolean(
      body.deviceThirdPartyInitiateLogin,
    );
  }
  if (body.tokenEndpointAuthMethod !== undefined) {
    // Primary stays public when confidential siblings exist.
    if (
      (app.m2mOidcClientId || app.webOidcClientId) &&
      body.tokenEndpointAuthMethod !== "none"
    ) {
      return NextResponse.json(
        {
          error: "public_client_no_secret",
          error_description:
            "The public app_ client must remain public while M2M or confidential web siblings exist.",
        },
        { status: 400 },
      );
    }
    clientUpdates.tokenEndpointAuthMethod = body.tokenEndpointAuthMethod;
  }

  let nextInitiateLoginUri = client.initiateLoginUri;
  if (body.initiateLoginUri !== undefined) {
    nextInitiateLoginUri = body.initiateLoginUri || null;
  }
  let nextDeviceThirdParty =
    client.deviceThirdPartyInitiateLogin === 1;
  if (body.deviceThirdPartyInitiateLogin !== undefined) {
    nextDeviceThirdParty = Boolean(body.deviceThirdPartyInitiateLogin);
  }
  if (nextDeviceThirdParty) {
    const uri = nextInitiateLoginUri?.trim();
    if (!uri) {
      return NextResponse.json(
        {
          error: "invalid_request",
          error_description:
            "Initiate login URI is required when device third-party login is enabled",
        },
        { status: 400 },
      );
    }
    try {
      validateInitiateLoginUri(uri);
    } catch {
      return NextResponse.json(
        {
          error: "invalid_request",
          error_description:
            "Initiate login URI must be a valid HTTPS URL (HTTP on localhost allowed in development)",
        },
        { status: 400 },
      );
    }
  }

  if (nextDeviceThirdParty && nextInitiateLoginUri?.trim()) {
    const grantTypes = client.grantTypes.split(",").filter(Boolean);
    const hasDeviceCode = grantTypes.includes(DEVICE_CODE_GRANT);
    if (hasDeviceCode) {
      const allowedScopes = client.allowedScopes.split(/[,\s]+/).filter(Boolean);
      if (!allowedScopes.includes("users:token")) {
        clientUpdates.allowedScopes = [...allowedScopes, "users:token"].join(" ");
      }
    }
  }

  // Auto-sync branding from developerApps
  clientUpdates.logoUri = app.logoLightUrl || null;
  clientUpdates.clientUri = app.websiteUrl || null;
  clientUpdates.policyUri = app.privacyPolicyUrl || null;
  clientUpdates.tosUri = app.tosUrl || null;

  await updateClientConfig(client.clientId, clientUpdates);

  // Auto-populate domain whitelist from public + confidential web redirect origins
  let webRedirectUris: string[] = [];
  if (app.webOidcClientId) {
    const webRows = await db
      .select({ redirectUris: oidcClients.redirectUris })
      .from(oidcClients)
      .where(eq(oidcClients.id, app.webOidcClientId))
      .limit(1);
    if (webRows[0]?.redirectUris) {
      try {
        webRedirectUris = JSON.parse(webRows[0].redirectUris) as string[];
      } catch {
        webRedirectUris = [];
      }
    }
  }
  const allRedirects = [
    ...(clientUpdates.redirectUris ?? JSON.parse(client.redirectUris) as string[]),
    ...(clientUpdates.postLogoutRedirectUris ?? []),
    ...webRedirectUris,
  ];
  const origins = extractOrigins(allRedirects);

  const existingDomains = await db
    .select()
    .from(appAllowedDomains)
    .where(eq(appAllowedDomains.appId, app.id));
  const existingSet = new Set(existingDomains.map((d) => d.domain.toLowerCase()));

  for (const origin of origins) {
    const result = normalizeDomainWhitelist(origin);
    if (!result.success) continue;
    const normalized = result.normalized.toLowerCase();
    if (!existingSet.has(normalized)) {
      await db.insert(appAllowedDomains).values({
        id: uuidv4(),
        appId: app.id,
        domain: result.normalized,
      });
      existingSet.add(normalized);
    }
  }

  // Reset provider so in-memory client cache picks up changes
  resetProvider();

  return NextResponse.json({ success: true });
}
