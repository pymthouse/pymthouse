export const AUTHORIZATION_CODE_GRANT = "authorization_code";

export const REFRESH_TOKEN_GRANT = "refresh_token";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export const CLIENT_CREDENTIALS_GRANT = "client_credentials";

/**
 * Default grant types for a newly created public app with no redirect URIs.
 * `authorization_code` is intentionally absent — it is added automatically
 * by {@link syncAuthorizationCodeGrant} once a redirect URI is registered.
 */
export const DEFAULT_PUBLIC_GRANT_TYPES = [
  REFRESH_TOKEN_GRANT,
] as const;

function isM2mClientId(clientId: string): boolean {
  return clientId.startsWith("m2m_");
}

export function parseGrantTypes(grantTypes: string): string[] {
  return grantTypes
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Enforce the RFC 6749 invariant: `authorization_code` belongs in grants if
 * and only if the client has at least one registered redirect URI.
 *
 * - `hasRedirectUris` true  → ensures `authorization_code` is present (prepended)
 * - `hasRedirectUris` false → removes `authorization_code` from the list
 *
 * All other grants are preserved as-is. Safe to call on M2M clients — pass
 * `false` for `hasRedirectUris` and they are left untouched.
 */
export function syncAuthorizationCodeGrant(
  grants: string[],
  hasRedirectUris: boolean,
): string[] {
  const without = grants.filter((g) => g !== AUTHORIZATION_CODE_GRANT);
  if (!hasRedirectUris) return without;
  return [AUTHORIZATION_CODE_GRANT, ...without];
}

/** Pass-through for M2M clients; apply {@link syncAuthorizationCodeGrant} for public ones. */
export function syncPublicClientGrantTypes(
  grants: string[],
  redirectUris: string[],
  clientId: string,
): string[] {
  if (isM2mClientId(clientId)) return grants;
  return syncAuthorizationCodeGrant(grants, redirectUris.length > 0);
}
