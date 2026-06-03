/** Interactive public apps always use authorization code + PKCE (hidden in app config UI). */
export const AUTHORIZATION_CODE_GRANT = "authorization_code";

export const REFRESH_TOKEN_GRANT = "refresh_token";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export const CLIENT_CREDENTIALS_GRANT = "client_credentials";

export const DEFAULT_PUBLIC_GRANT_TYPES = [
  AUTHORIZATION_CODE_GRANT,
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

/** Public OIDC clients always allow authorization code; omit from app config UI. */
export function ensureAuthorizationCodeGrant(grantTypes: string[]): string[] {
  if (grantTypes.includes(AUTHORIZATION_CODE_GRANT)) {
    return grantTypes;
  }
  return [AUTHORIZATION_CODE_GRANT, ...grantTypes];
}

export function normalizePublicGrantTypesList(
  grantTypes: string[],
  clientId: string,
): string[] {
  if (isM2mClientId(clientId)) {
    return grantTypes;
  }
  return ensureAuthorizationCodeGrant(grantTypes);
}

export function normalizePublicGrantTypes(
  grantTypes: string,
  clientId: string,
): string {
  return normalizePublicGrantTypesList(parseGrantTypes(grantTypes), clientId).join(
    ",",
  );
}
