/**
 * OIDC provider token TTLs (node-oidc-provider `ttl.*` and resource-indicator
 * `accessTokenTTL`). Programmatic mint (`POST …/users/{eu}/token`) and signer
 * session JWTs keep their own hardcoded lifetimes and must not read these env
 * vars.
 */

export const OIDC_ACCESS_TOKEN_TTL_ENV = "OIDC_ACCESS_TOKEN_TTL_SECONDS";
export const OIDC_REFRESH_TOKEN_TTL_ENV = "OIDC_REFRESH_TOKEN_TTL_SECONDS";

/** Access JWT default: 1 hour. Keep short; clients refresh. */
export const DEFAULT_OIDC_ACCESS_TOKEN_TTL_SECONDS = 3600;

/**
 * Refresh default: 90 days. Grant and Session follow this so a rotated refresh
 * stays valid for the full window (they used to be 14 days while refresh was 30).
 */
export const DEFAULT_OIDC_REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 3600;

export type OidcProviderTtls = {
  accessToken: number;
  refreshToken: number;
  grant: number;
  session: number;
};

/**
 * Positive whole seconds from env, otherwise `fallback`. Invalid, zero, and
 * negative values are ignored so a bad deploy cannot mint zero-lifetime tokens.
 */
export function resolvePositiveIntegerSecondsEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^[1-9]\d*$/.test(raw)) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function resolveOidcAccessTokenTtlSeconds(): number {
  return resolvePositiveIntegerSecondsEnv(
    OIDC_ACCESS_TOKEN_TTL_ENV,
    DEFAULT_OIDC_ACCESS_TOKEN_TTL_SECONDS,
  );
}

export function resolveOidcRefreshTokenTtlSeconds(): number {
  return resolvePositiveIntegerSecondsEnv(
    OIDC_REFRESH_TOKEN_TTL_ENV,
    DEFAULT_OIDC_REFRESH_TOKEN_TTL_SECONDS,
  );
}

/**
 * Access / refresh from env; Grant and Session are at least the refresh TTL so
 * consent does not expire while a rotated refresh is still in the advertised
 * window.
 */
export function resolveOidcProviderTtls(): OidcProviderTtls {
  const accessToken = resolveOidcAccessTokenTtlSeconds();
  const refreshToken = resolveOidcRefreshTokenTtlSeconds();
  return {
    accessToken,
    refreshToken,
    grant: refreshToken,
    session: refreshToken,
  };
}
