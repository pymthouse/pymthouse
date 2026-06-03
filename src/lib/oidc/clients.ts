import { db } from "@/db/index";
import { developerApps, oidcClients, oidcPayloads } from "@/db/schema";
import { eq, or, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { randomBytes } from "crypto";
import {
  computeBackendM2mAllowedScopes,
} from "@/lib/oidc/backend-m2m-scopes";
import {
  DEFAULT_PUBLIC_GRANT_TYPES,
  normalizePublicGrantTypes,
} from "@/lib/oidc/grants";
import {
  DEFAULT_OIDC_SCOPES,
  ensureOpenIdScope,
  OIDC_SCOPES,
} from "@/lib/oidc/scopes";

export { computeBackendM2mAllowedScopes };
import { hashToken } from "@/lib/token-hash";

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

function isM2mClientId(clientId: string): boolean {
  return clientId.startsWith("m2m_");
}

/** Public OIDC clients always carry `openid`; M2M helper clients keep computed scopes as-is. */
export function normalizePublicAllowedScopes(
  allowedScopes: string,
  clientId: string,
): string {
  if (isM2mClientId(clientId)) {
    return allowedScopes;
  }
  return ensureOpenIdScope(allowedScopes);
}

export async function registerClient(config: OidcClientConfig): Promise<void> {
  const existingRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, config.clientId))
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    await db
      .update(oidcClients)
      .set({
        displayName: config.displayName,
        redirectUris: JSON.stringify(config.redirectUris),
        allowedScopes: normalizePublicAllowedScopes(
          config.allowedScopes || DEFAULT_OIDC_SCOPES,
          config.clientId,
        ),
        grantTypes: normalizePublicGrantTypes(
          (config.grantTypes || [...DEFAULT_PUBLIC_GRANT_TYPES]).join(","),
          config.clientId,
        ),
        tokenEndpointAuthMethod: config.tokenEndpointAuthMethod || "none",
        clientSecretHash: config.clientSecret
          ? hashClientSecret(config.clientSecret)
          : null,
      })
      .where(eq(oidcClients.clientId, config.clientId));
    return;
  }

  await db.insert(oidcClients).values({
    id: uuidv4(),
    clientId: config.clientId,
    clientSecretHash: config.clientSecret
      ? hashClientSecret(config.clientSecret)
      : null,
    displayName: config.displayName,
    redirectUris: JSON.stringify(config.redirectUris),
    allowedScopes: normalizePublicAllowedScopes(
      config.allowedScopes || DEFAULT_OIDC_SCOPES,
      config.clientId,
    ),
    grantTypes: normalizePublicGrantTypes(
      (config.grantTypes || [...DEFAULT_PUBLIC_GRANT_TYPES]).join(","),
      config.clientId,
    ),
    tokenEndpointAuthMethod: config.tokenEndpointAuthMethod || "none",
  });
}

/**
 * Return the set of allowed redirect URI origins for all registered clients.
 */
export async function getRegisteredRedirectOrigins(): Promise<Set<string>> {
  const rows = await db.select().from(oidcClients);
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
          } catch {
            /* malformed URI, skip */
          }
        }
      } else {
        try {
          origins.add(new URL(uri).origin);
        } catch {
          /* malformed URI, skip */
        }
      }
    }
  }

  return origins;
}

/**
 * `initiate_login_uri` for OIDC third-party login initiation, only when the app opted in
 * for device-flow redirects (off by default).
 */
export async function getInitiateLoginUriForDeviceFlow(
  clientId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      initiateLoginUri: oidcClients.initiateLoginUri,
      deviceThirdPartyInitiateLogin: oidcClients.deviceThirdPartyInitiateLogin,
    })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  const row = rows[0];
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
  const rows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  const client = rows[0];

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

/**
 * Get all OIDC clients in the database.
 * Used primarily for admin interfaces to view/manage all clients.
 */
export async function getAllClients(): Promise<Array<{
  id: string;
  clientId: string;
  displayName: string;
  redirectUris: string[];
  allowedScopes: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  hasSecret: boolean;
  createdAt: string;
}>> {
  const rows = await db.select().from(oidcClients);

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

export async function validateRedirectUri(
  clientId: string,
  redirectUri: string,
): Promise<boolean> {
  const client = await getClient(clientId);
  if (!client) return false;

  return client.redirectUris.some((pattern) => {
    if (pattern.includes("*")) {
      const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const wildcardPattern = escapedPattern.replace(/\\\*/g, ".*");
      const regex = new RegExp("^" + wildcardPattern + "$");
      return regex.test(redirectUri);
    }
    return pattern === redirectUri;
  });
}

export async function validateClientSecret(
  clientId: string,
  clientSecret: string,
): Promise<boolean> {
  const client = await getClient(clientId);
  if (!client || !client.clientSecretHash) return false;

  const providedHash = hashClientSecret(clientSecret);
  return providedHash === client.clientSecretHash;
}

export async function validateScopes(
  clientId: string,
  requestedScopes: string[],
): Promise<string[]> {
  const client = await getClient(clientId);
  if (!client) return [];

  return requestedScopes.filter((scope) => client.allowedScopes.includes(scope));
}

export function generateClientId(): string {
  return `app_${randomBytes(12).toString("hex")}`;
}

/** Confidential sibling client_id for Builder API + RFC 8693 device approval token exchange (not used in public SDK config). */
export function generateM2mClientId(): string {
  return `m2m_${randomBytes(12).toString("hex")}`;
}

export function generateClientSecret(): string {
  return `pmth_cs_${randomBytes(32).toString("hex")}`;
}

/**
 * Create an OIDC client for a developer app. Returns the DB row ID and
 * the generated client_id (no secret yet -- that comes from rotateClientSecret).
 */
export async function createAppClient(displayName: string): Promise<{
  id: string;
  clientId: string;
}> {
  const id = uuidv4();
  const clientId = generateClientId();

  await db.insert(oidcClients).values({
    id,
    clientId,
    clientSecretHash: null,
    displayName,
    redirectUris: JSON.stringify([]),
    allowedScopes: DEFAULT_OIDC_SCOPES,
    grantTypes: "authorization_code,refresh_token",
    tokenEndpointAuthMethod: "none",
  });

  return { id, clientId };
}

/**
 * Generate a new client secret (or rotate an existing one).
 * Returns the plaintext secret -- it is NOT stored and must be shown to the user once.
 */
export async function rotateClientSecret(clientId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  const client = rows[0];

  if (!client) return null;

  const secret = generateClientSecret();
  const secretHash = hashClientSecret(secret);

  await db
    .update(oidcClients)
    .set({
      clientSecretHash: secretHash,
    })
    .where(eq(oidcClients.clientId, clientId));

  return secret;
}

function normalizeScopeListString(scopes: string): string {
  return scopes
    .split(/[,\s]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * Updates the backend M2M client's `allowedScopes` from the public client's
 * configured scopes. Call after saving the public OIDC client.
 *
 * @returns true when the M2M row was updated (caller should reload OIDC provider cache).
 */
export async function syncBackendM2mAllowedScopesFromPublicApp(
  appInternalId: string,
): Promise<boolean> {
  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appInternalId))
    .limit(1);
  const app = appRows[0];
  if (!app?.oidcClientId || !app.m2mOidcClientId) {
    return false;
  }

  const publicRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientId))
    .limit(1);
  const m2mRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, app.m2mOidcClientId))
    .limit(1);
  const pub = publicRows[0];
  const m2m = m2mRows[0];
  if (!pub || !m2m) {
    return false;
  }

  const next = computeBackendM2mAllowedScopes(
    pub.allowedScopes ?? DEFAULT_OIDC_SCOPES,
  );
  if (normalizeScopeListString(next) === normalizeScopeListString(m2m.allowedScopes)) {
    return false;
  }

  await updateClientConfig(m2m.clientId, { allowedScopes: next });
  return true;
}

/**
 * When a confidential m2m_ sibling exists, the primary app_ row must remain public.
 * Repairs legacy rows that still have a secret or client_credentials on app_.
 */
export async function demotePublicClientWhenM2mSiblingExists(
  appInternalId: string,
): Promise<boolean> {
  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appInternalId))
    .limit(1);
  const app = appRows[0];
  if (!app?.oidcClientId || !app.m2mOidcClientId) {
    return false;
  }

  const pubRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientId))
    .limit(1);
  const pub = pubRows[0];
  if (!pub) {
    return false;
  }

  const grants = pub.grantTypes.split(",").filter(Boolean);
  const nextGrants = grants.filter((g) => g !== "client_credentials");
  const needsUpdate =
    pub.clientSecretHash != null ||
    pub.tokenEndpointAuthMethod !== "none" ||
    grants.length !== nextGrants.length;

  if (!needsUpdate) {
    return false;
  }

  await db
    .update(oidcClients)
    .set({
      clientSecretHash: null,
      tokenEndpointAuthMethod: "none",
      grantTypes: nextGrants.join(","),
    })
    .where(eq(oidcClients.id, app.oidcClientId));

  return true;
}

/**
 * Ensures a confidential M2M OIDC row exists for interactive apps that need
 * Builder API / device approval without turning the public client confidential.
 */
export async function ensureM2mBackendClient(params: {
  appInternalId: string;
  appDisplayName: string;
}): Promise<{ id: string; clientId: string } | null> {
  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, params.appInternalId))
    .limit(1);
  const app = appRows[0];
  if (!app?.oidcClientId) {
    return null;
  }

  if (app.m2mOidcClientId) {
    const existing = await db
      .select()
      .from(oidcClients)
      .where(eq(oidcClients.id, app.m2mOidcClientId))
      .limit(1);
    if (existing[0]) {
      await demotePublicClientWhenM2mSiblingExists(params.appInternalId);
      return { id: existing[0].id, clientId: existing[0].clientId };
    }
  }

  const pubRows = await db
    .select({ allowedScopes: oidcClients.allowedScopes })
    .from(oidcClients)
    .where(eq(oidcClients.id, app.oidcClientId))
    .limit(1);
  const publicScopes = pubRows[0]?.allowedScopes ?? DEFAULT_OIDC_SCOPES;

  const id = uuidv4();
  const clientId = generateM2mClientId();
  const display =
    params.appDisplayName.trim().slice(0, 80) || "Provider app";

  await db.insert(oidcClients).values({
    id,
    clientId,
    clientSecretHash: null,
    displayName: `${display} - backend helper`,
    redirectUris: JSON.stringify([]),
    allowedScopes: computeBackendM2mAllowedScopes(publicScopes),
    grantTypes: "client_credentials",
    tokenEndpointAuthMethod: "client_secret_basic",
    deviceThirdPartyInitiateLogin: 0,
    initiateLoginUri: null,
  });

  await db
    .update(developerApps)
    .set({ m2mOidcClientId: id })
    .where(eq(developerApps.id, params.appInternalId));

  await demotePublicClientWhenM2mSiblingExists(params.appInternalId);

  return { id, clientId };
}

async function deleteOidcPayloadsForClientId(oauthClientId: string): Promise<void> {
  await db.delete(oidcPayloads).where(
    or(
      sql`(${oidcPayloads.payload})::jsonb->>'clientId' = ${oauthClientId}`,
      sql`(${oidcPayloads.payload})::jsonb->>'client_id' = ${oauthClientId}`,
    ),
  );
}

/**
 * Removes the confidential backend helper (m2m_) for an interactive app.
 * Clears `developer_apps.m2m_oidc_client_id` and deletes the OIDC client row.
 */
export async function removeM2mBackendClient(
  appInternalId: string,
): Promise<boolean> {
  const appRows = await db
    .select({ m2mOidcClientId: developerApps.m2mOidcClientId })
    .from(developerApps)
    .where(eq(developerApps.id, appInternalId))
    .limit(1);
  const m2mPk = appRows[0]?.m2mOidcClientId;
  if (!m2mPk) {
    return false;
  }

  const m2mRows = await db
    .select({ clientId: oidcClients.clientId })
    .from(oidcClients)
    .where(eq(oidcClients.id, m2mPk))
    .limit(1);
  const oauthClientId = m2mRows[0]?.clientId;

  await db
    .update(developerApps)
    .set({ m2mOidcClientId: null })
    .where(eq(developerApps.id, appInternalId));

  if (oauthClientId) {
    await deleteOidcPayloadsForClientId(oauthClientId);
  }
  await db.delete(oidcClients).where(eq(oidcClients.id, m2mPk));

  return true;
}

export async function loadM2mOidcClientSummary(
  appInternalId: string,
): Promise<{ clientId: string; hasSecret: boolean } | null> {
  const appRows = await db
    .select({ m2mOidcClientId: developerApps.m2mOidcClientId })
    .from(developerApps)
    .where(eq(developerApps.id, appInternalId))
    .limit(1);
  const m2mPk = appRows[0]?.m2mOidcClientId;
  if (!m2mPk) {
    return null;
  }

  const m2mRows = await db
    .select({
      clientId: oidcClients.clientId,
      clientSecretHash: oidcClients.clientSecretHash,
    })
    .from(oidcClients)
    .where(eq(oidcClients.id, m2mPk))
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
  const rows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  const existing = rows[0];

  if (!existing) return false;

  const updates: Record<string, unknown> = {};
  if (config.displayName !== undefined) updates.displayName = config.displayName;
  if (config.redirectUris !== undefined) updates.redirectUris = JSON.stringify(config.redirectUris);
  if (config.allowedScopes !== undefined) {
    updates.allowedScopes = normalizePublicAllowedScopes(
      config.allowedScopes,
      clientId,
    );
  }
  if (config.grantTypes !== undefined) {
    updates.grantTypes = normalizePublicGrantTypes(
      config.grantTypes.join(","),
      clientId,
    );
  }
  if (config.tokenEndpointAuthMethod !== undefined) {
    updates.tokenEndpointAuthMethod = config.tokenEndpointAuthMethod;
  }
  if (config.postLogoutRedirectUris !== undefined) {
    updates.postLogoutRedirectUris = JSON.stringify(config.postLogoutRedirectUris);
  }
  if (config.deviceThirdPartyInitiateLogin !== undefined) {
    updates.deviceThirdPartyInitiateLogin = config.deviceThirdPartyInitiateLogin ? 1 : 0;
  }
  if (config.initiateLoginUri !== undefined) updates.initiateLoginUri = config.initiateLoginUri;
  if (config.logoUri !== undefined) updates.logoUri = config.logoUri;
  if (config.policyUri !== undefined) updates.policyUri = config.policyUri;
  if (config.tosUri !== undefined) updates.tosUri = config.tosUri;
  if (config.clientUri !== undefined) updates.clientUri = config.clientUri;

  if (Object.keys(updates).length === 0) return true;

  await db.update(oidcClients).set(updates).where(eq(oidcClients.clientId, clientId));

  return true;
}
