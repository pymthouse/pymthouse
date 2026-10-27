import { randomBytes } from "crypto";
import { hashToken } from "@/shared/utils/token-hash";
import { computeBackendM2mAllowedScopes } from "@/platform/oidc/backend-m2m-scopes";
import { DEFAULT_OIDC_SCOPES } from "@/platform/oidc/scopes";
import {
  createBasicOidcClient,
  getDeveloperAppById,
  getOidcClientByClientId,
  getOidcClientById,
  getOidcClientDeviceInitiateLogin,
  listOidcClients,
  updateDeveloperAppM2mOidcClientId,
  updateOidcClientByClientId,
} from "../repo/clients";

export { computeBackendM2mAllowedScopes };

export interface OidcClientConfig {
  clientId: string;
  clientSecret?: string;
  displayName: string;
  redirectUris: string[];
  allowedScopes?: string;
  grantTypes?: string[];
  tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
}

export function hashClientSecret(secret: string): string {
  return hashToken(secret);
}

export async function registerClient(config: OidcClientConfig): Promise<void> {
  const existing = await getOidcClientByClientId(config.clientId);

  if (existing) {
    await updateOidcClientByClientId(config.clientId, {
      displayName: config.displayName,
      redirectUris: JSON.stringify(config.redirectUris),
      allowedScopes: config.allowedScopes || DEFAULT_OIDC_SCOPES,
      grantTypes: (config.grantTypes || ["authorization_code", "refresh_token"]).join(","),
      tokenEndpointAuthMethod: config.tokenEndpointAuthMethod || "none",
      clientSecretHash: config.clientSecret ? hashClientSecret(config.clientSecret) : null,
    });
    return;
  }

  await createBasicOidcClient({
    clientId: config.clientId,
    displayName: config.displayName,
    clientSecretHash: config.clientSecret ? hashClientSecret(config.clientSecret) : null,
    redirectUrisJson: JSON.stringify(config.redirectUris),
    allowedScopes: config.allowedScopes || DEFAULT_OIDC_SCOPES,
    grantTypes: (config.grantTypes || ["authorization_code", "refresh_token"]).join(","),
    tokenEndpointAuthMethod: config.tokenEndpointAuthMethod || "none",
  });
}

export async function getRegisteredRedirectOrigins(): Promise<Set<string>> {
  const rows = await listOidcClients();
  const origins = new Set<string>();
  const commonPorts = [
    "3000", "3001", "3002", "3003", "3004", "3005",
    "4000", "4001", "4200", "5000", "5173", "5174",
    "8000", "8080", "8081", "8888", "9000",
  ];

  for (const row of rows) {
    const uris = JSON.parse(row.redirectUris) as string[];
    for (const uri of uris) {
      if (uri.includes("*")) {
        for (const port of commonPorts) {
          try {
            origins.add(new URL(uri.replace(/:\*/, `:${port}`).replace(/\*/g, "")).origin);
          } catch {}
        }
      } else {
        try {
          origins.add(new URL(uri).origin);
        } catch {}
      }
    }
  }

  return origins;
}

export async function getInitiateLoginUriForDeviceFlow(clientId: string): Promise<string | null> {
  const row = await getOidcClientDeviceInitiateLogin(clientId);
  if (!row || row.deviceThirdPartyInitiateLogin !== 1) return null;
  const uri = row.initiateLoginUri;
  return typeof uri === "string" && uri.trim() ? uri.trim() : null;
}

export async function getClient(clientId: string): Promise<{
  id: string;
  clientId: string;
  displayName: string;
  redirectUris: string[];
  allowedScopes: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  clientSecretHash: string | null;
  createdAt: string;
} | null> {
  const client = await getOidcClientByClientId(clientId);
  if (!client) return null;

  return {
    id: client.id,
    clientId: client.clientId,
    displayName: client.displayName,
    redirectUris: JSON.parse(client.redirectUris) as string[],
    allowedScopes: client.allowedScopes.split(/[,\s]+/).filter(Boolean),
    grantTypes: client.grantTypes.split(",").filter(Boolean),
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    clientSecretHash: client.clientSecretHash,
    createdAt: client.createdAt,
  };
}

export async function getAllClients() {
  const rows = await listOidcClients();
  return rows.map((client) => ({
    id: client.id,
    clientId: client.clientId,
    displayName: client.displayName,
    redirectUris: JSON.parse(client.redirectUris) as string[],
    allowedScopes: client.allowedScopes.split(/[,\s]+/).filter(Boolean),
    grantTypes: client.grantTypes.split(",").filter(Boolean),
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    hasSecret: !!client.clientSecretHash,
    createdAt: client.createdAt,
  }));
}

export async function validateRedirectUri(clientId: string, redirectUri: string): Promise<boolean> {
  const client = await getClient(clientId);
  if (!client) return false;

  return client.redirectUris.some((pattern) => {
    if (pattern.includes("*")) {
      const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const wildcardPattern = escapedPattern.replace(/\\\*/g, ".*");
      return new RegExp(`^${wildcardPattern}$`).test(redirectUri);
    }
    return pattern === redirectUri;
  });
}

export async function validateClientSecret(clientId: string, clientSecret: string): Promise<boolean> {
  const client = await getClient(clientId);
  if (!client || !client.clientSecretHash) return false;
  return hashClientSecret(clientSecret) === client.clientSecretHash;
}

export async function validateScopes(clientId: string, requestedScopes: string[]): Promise<string[]> {
  const client = await getClient(clientId);
  if (!client) return [];
  return requestedScopes.filter((scope) => client.allowedScopes.includes(scope));
}

export function generateClientId(): string {
  return `app_${randomBytes(12).toString("hex")}`;
}

export function generateM2mClientId(): string {
  return `m2m_${randomBytes(12).toString("hex")}`;
}

export function generateClientSecret(): string {
  return `pmth_cs_${randomBytes(32).toString("hex")}`;
}

export async function createAppClient(displayName: string): Promise<{ id: string; clientId: string }> {
  const clientId = generateClientId();
  return createBasicOidcClient({
    clientId,
    displayName,
    clientSecretHash: null,
    redirectUrisJson: JSON.stringify([]),
    allowedScopes: DEFAULT_OIDC_SCOPES,
    grantTypes: "authorization_code,refresh_token",
    tokenEndpointAuthMethod: "none",
  });
}

export async function rotateClientSecret(clientId: string): Promise<string | null> {
  const client = await getOidcClientByClientId(clientId);
  if (!client) return null;

  const secret = generateClientSecret();
  await updateOidcClientByClientId(clientId, { clientSecretHash: hashClientSecret(secret) });
  return secret;
}

function normalizeScopeListString(scopes: string): string {
  return scopes.split(/[,\s]+/).filter(Boolean).sort().join(" ");
}

export async function syncBackendM2mAllowedScopesFromPublicApp(appInternalId: string): Promise<boolean> {
  const app = await getDeveloperAppById(appInternalId);
  if (!app?.oidcClientId || !app.m2mOidcClientId) return false;

  const pub = await getOidcClientById(app.oidcClientId);
  const m2m = await getOidcClientById(app.m2mOidcClientId);
  if (!pub || !m2m) return false;

  const next = computeBackendM2mAllowedScopes(pub.allowedScopes ?? DEFAULT_OIDC_SCOPES);
  if (normalizeScopeListString(next) === normalizeScopeListString(m2m.allowedScopes)) {
    return false;
  }

  await updateClientConfig(m2m.clientId, { allowedScopes: next });
  return true;
}

export async function ensureM2mBackendClient(params: {
  appInternalId: string;
  appDisplayName: string;
}): Promise<{ id: string; clientId: string } | null> {
  const app = await getDeveloperAppById(params.appInternalId);
  if (!app?.oidcClientId) return null;

  if (app.m2mOidcClientId) {
    const existing = await getOidcClientById(app.m2mOidcClientId);
    if (existing) {
      return { id: existing.id, clientId: existing.clientId };
    }
  }

  const pub = await getOidcClientById(app.oidcClientId);
  const publicScopes = pub?.allowedScopes ?? DEFAULT_OIDC_SCOPES;

  const clientId = generateM2mClientId();
  const display = params.appDisplayName.trim().slice(0, 80) || "Provider app";

  const client = await createBasicOidcClient({
    clientId,
    displayName: `${display} - backend helper`,
    clientSecretHash: null,
    redirectUrisJson: JSON.stringify([]),
    allowedScopes: computeBackendM2mAllowedScopes(publicScopes),
    grantTypes: "client_credentials",
    tokenEndpointAuthMethod: "client_secret_basic",
  });
  await updateOidcClientByClientId(clientId, {
    deviceThirdPartyInitiateLogin: 0,
    initiateLoginUri: null,
  });
  await updateDeveloperAppM2mOidcClientId(params.appInternalId, client.id);
  return client;
}

export async function updateClientConfig(
  clientId: string,
  config: {
    displayName?: string;
    redirectUris?: string[];
    allowedScopes?: string;
    grantTypes?: string[];
    tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
    postLogoutRedirectUris?: string[];
    deviceThirdPartyInitiateLogin?: boolean;
    initiateLoginUri?: string | null;
    logoUri?: string | null;
    policyUri?: string | null;
    tosUri?: string | null;
    clientUri?: string | null;
  },
): Promise<boolean> {
  const existing = await getOidcClientByClientId(clientId);
  if (!existing) return false;

  const updates: Record<string, unknown> = {};
  if (config.displayName !== undefined) updates.displayName = config.displayName;
  if (config.redirectUris !== undefined) updates.redirectUris = JSON.stringify(config.redirectUris);
  if (config.allowedScopes !== undefined) updates.allowedScopes = config.allowedScopes;
  if (config.grantTypes !== undefined) updates.grantTypes = config.grantTypes.join(",");
  if (config.tokenEndpointAuthMethod !== undefined) updates.tokenEndpointAuthMethod = config.tokenEndpointAuthMethod;
  if (config.postLogoutRedirectUris !== undefined) updates.postLogoutRedirectUris = JSON.stringify(config.postLogoutRedirectUris);
  if (config.deviceThirdPartyInitiateLogin !== undefined) updates.deviceThirdPartyInitiateLogin = config.deviceThirdPartyInitiateLogin ? 1 : 0;
  if (config.initiateLoginUri !== undefined) updates.initiateLoginUri = config.initiateLoginUri;
  if (config.logoUri !== undefined) updates.logoUri = config.logoUri;
  if (config.policyUri !== undefined) updates.policyUri = config.policyUri;
  if (config.tosUri !== undefined) updates.tosUri = config.tosUri;
  if (config.clientUri !== undefined) updates.clientUri = config.clientUri;
  if (Object.keys(updates).length === 0) return true;

  await updateOidcClientByClientId(clientId, updates);
  return true;
}
