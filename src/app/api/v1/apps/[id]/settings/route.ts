import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/index";
import { developerApps, oidcClients, appAllowedDomains } from "@/db/schema";
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

function buildSettingsClientUpdates(
  body: Record<string, unknown>,
  client: typeof oidcClients.$inferSelect,
  app: {
    logoLightUrl: string | null;
    websiteUrl: string | null;
    privacyPolicyUrl: string | null;
    tosUrl: string | null;
  },
): Parameters<typeof updateClientConfig>[1] {
  const clientUpdates: Parameters<typeof updateClientConfig>[1] = {};

  if (Array.isArray(body.redirectUris)) {
    clientUpdates.redirectUris = body.redirectUris as string[];
  }
  if (Array.isArray(body.postLogoutRedirectUris)) {
    clientUpdates.postLogoutRedirectUris = body.postLogoutRedirectUris as string[];
  }
  if (body.initiateLoginUri !== undefined) {
    clientUpdates.initiateLoginUri = (body.initiateLoginUri as string) || null;
  }
  if (body.deviceThirdPartyInitiateLogin !== undefined) {
    clientUpdates.deviceThirdPartyInitiateLogin = Boolean(
      body.deviceThirdPartyInitiateLogin,
    );
  }
  if (body.tokenEndpointAuthMethod !== undefined) {
    clientUpdates.tokenEndpointAuthMethod =
      body.tokenEndpointAuthMethod as "none" | "client_secret_post" | "client_secret_basic";
  }

  // Auto-sync branding from developerApps
  clientUpdates.logoUri = app.logoLightUrl || null;
  clientUpdates.clientUri = app.websiteUrl || null;
  clientUpdates.policyUri = app.privacyPolicyUrl || null;
  clientUpdates.tosUri = app.tosUrl || null;

  const nextInitiateLoginUri =
    body.initiateLoginUri !== undefined
      ? ((body.initiateLoginUri as string) || null)
      : client.initiateLoginUri;
  const nextDeviceThirdParty =
    body.deviceThirdPartyInitiateLogin !== undefined
      ? Boolean(body.deviceThirdPartyInitiateLogin)
      : client.deviceThirdPartyInitiateLogin === 1;

  if (nextDeviceThirdParty && nextInitiateLoginUri?.trim()) {
    const grantTypes = client.grantTypes.split(",").filter(Boolean);
    if (grantTypes.includes(DEVICE_CODE_GRANT)) {
      const allowedScopes = client.allowedScopes.split(/[,\s]+/).filter(Boolean);
      if (!allowedScopes.includes("users:token")) {
        clientUpdates.allowedScopes = [...allowedScopes, "users:token"].join(" ");
      }
    }
  }

  return clientUpdates;
}

function validateDeviceThirdPartySettings(
  body: Record<string, unknown>,
  client: typeof oidcClients.$inferSelect,
): NextResponse | null {
  let nextInitiateLoginUri = client.initiateLoginUri;
  if (body.initiateLoginUri !== undefined) {
    nextInitiateLoginUri = (body.initiateLoginUri as string) || null;
  }
  let nextDeviceThirdParty = client.deviceThirdPartyInitiateLogin === 1;
  if (body.deviceThirdPartyInitiateLogin !== undefined) {
    nextDeviceThirdParty = Boolean(body.deviceThirdPartyInitiateLogin);
  }
  if (!nextDeviceThirdParty) {
    return null;
  }
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
  return null;
}

async function syncDomainWhitelistFromRedirects(
  appId: string,
  allRedirects: string[],
) {
  const origins = extractOrigins(allRedirects);
  const existingDomains = await db
    .select()
    .from(appAllowedDomains)
    .where(eq(appAllowedDomains.appId, appId));
  const existingSet = new Set(existingDomains.map((d) => d.domain.toLowerCase()));

  for (const origin of origins) {
    const result = normalizeDomainWhitelist(origin);
    if (!result.success) continue;
    const normalized = result.normalized.toLowerCase();
    if (existingSet.has(normalized)) continue;
    await db.insert(appAllowedDomains).values({
      id: uuidv4(),
      appId,
      domain: result.normalized,
    });
    existingSet.add(normalized);
  }
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

  const validationErr = validateDeviceThirdPartySettings(body, client);
  if (validationErr) {
    return validationErr;
  }

  const clientUpdates = buildSettingsClientUpdates(body, client, app);
  await updateClientConfig(client.clientId, clientUpdates);

  // Auto-populate domain whitelist from redirect URI origins
  const allRedirects = [
    ...(clientUpdates.redirectUris ?? JSON.parse(client.redirectUris) as string[]),
    ...(clientUpdates.postLogoutRedirectUris ?? []),
  ];
  await syncDomainWhitelistFromRedirects(app.id, allRedirects);

  // Reset provider so in-memory client cache picks up changes
  resetProvider();

  return NextResponse.json({ success: true });
}
