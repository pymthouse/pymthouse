export const AUTHORIZATION_CODE_GRANT = "authorization_code";

export const REFRESH_TOKEN_GRANT = "refresh_token";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export const CLIENT_CREDENTIALS_GRANT = "client_credentials";

/**
 * Default grant types for a newly created public app with no redirect URIs.
 * Authorization code lives on the confidential `web_` sibling (portal SSO), not
 * on the public `app_` client (device / SDK / API-key routing).
 */
export const DEFAULT_PUBLIC_GRANT_TYPES = [
  REFRESH_TOKEN_GRANT,
] as const;

function isM2mClientId(clientId: string): boolean {
  return clientId.startsWith("m2m_");
}

function isPublicAppClientId(clientId: string): boolean {
  return clientId.startsWith("app_");
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

/**
 * Public `app_` clients never advertise authorization_code — browser / portal
 * redirect login uses the confidential `web_` sibling. M2M clients are unchanged.
 * Non-app / non-m2m ids (legacy) still sync auth code from redirect URIs.
 */
export function syncPublicClientGrantTypes(
  grants: string[],
  redirectUris: string[],
  clientId: string,
): string[] {
  if (isM2mClientId(clientId)) return grants;
  if (isPublicAppClientId(clientId)) {
    return grants.filter((g) => g !== AUTHORIZATION_CODE_GRANT);
  }
  return syncAuthorizationCodeGrant(grants, redirectUris.length > 0);
}
