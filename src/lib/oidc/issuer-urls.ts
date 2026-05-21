/**
 * Issuer / origin URL helpers only — safe to import from Client Components.
 * Do not import DB-backed JWKS or token verification from here.
 */

export const OIDC_MOUNT_PATH = "/api/v1/oidc";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** HTTP may stay http for loopback, RFC1918, IPv6 link-local, and *.local dev hosts. */
function isLocalOrPrivateHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  h = h.split("%")[0] ?? h;

  if (h === "localhost" || h === "::1" || h === "127.0.0.1") return true;
  if (h.endsWith(".local")) return true;

  const dottedQuad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const plain4 = h.match(dottedQuad);
  if (plain4) {
    const a = Number(plain4[1]);
    const b = Number(plain4[2]);
    const c = Number(plain4[3]);
    const d = Number(plain4[4]);
    if (![a, b, c, d].every((x) => x >= 0 && x <= 255)) return false;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  const embedded4 = h.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (embedded4) {
    const a = Number(embedded4[1]);
    const b = Number(embedded4[2]);
    const c = Number(embedded4[3]);
    const d = Number(embedded4[4]);
    if ([a, b, c, d].every((x) => x >= 0 && x <= 255)) {
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
    }
  }

  const firstHextet = h.split(":")[0];
  if (firstHextet) {
    const n = parseInt(firstHextet, 16);
    if (!Number.isNaN(n) && n >= 0xfe80 && n <= 0xfebf) return true;
  }

  return false;
}

function ensureHttpsForProduction(url: string): string {
  try {
    const u = new URL(url);
    if (!isLocalOrPrivateHost(u.hostname) && u.protocol === "http:") {
      u.protocol = "https:";
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return url;
}

export function getPublicOrigin(): string {
  const raw = process.env.NEXTAUTH_URL || "http://localhost:3001";
  return trimTrailingSlash(ensureHttpsForProduction(raw));
}

export function getIssuer(): string {
  const configured =
    process.env.OIDC_ISSUER || process.env.NEXTAUTH_URL || "http://localhost:3001";
  const normalized = trimTrailingSlash(ensureHttpsForProduction(configured));
  return normalized.endsWith(OIDC_MOUNT_PATH)
    ? normalized
    : `${normalized}${OIDC_MOUNT_PATH}`;
}

export function getCanonicalIssuer(): string {
  return getIssuer();
}

/**
 * Canonical JWKS URL this app serves at GET (issuer)/jwks — same origin as the
 * OIDC issuer. Tokens and discovery reference this URL; audience matches issuer.
 */
export function getOidcJwksUrl(): string {
  return `${getIssuer()}/jwks`;
}

/**
 * JWKS URL stored in `developer_apps.jwks_uri` for RFC 8693 token exchange.
 * Must be publicly reachable (not loopback). Defaults to production; set
 * `PLATFORM_JWKS_URL` for self-hosted deployments.
 */
export function getPlatformJwksUrlForDatabase(): string {
  const fromEnv = process.env.PLATFORM_JWKS_URL?.trim();
  if (fromEnv) return fromEnv;
  return `https://pymthouse.com${OIDC_MOUNT_PATH}/jwks`;
}

/**
 * Public OIDC issuer for Remote Signer UI and docs — matches
 * {@link getPlatformJwksUrlForDatabase} without the `/jwks` suffix. Not the same
 * as {@link getIssuer} when NEXTAUTH_URL is localhost.
 */
export function getPlatformPublicOidcIssuer(): string {
  const jwks = getPlatformJwksUrlForDatabase();
  if (jwks.endsWith("/jwks")) {
    return jwks.slice(0, -"/jwks".length);
  }
  try {
    const u = new URL(jwks);
    u.pathname = u.pathname.replace(/\/jwks\/?$/, "") || OIDC_MOUNT_PATH;
    return trimTrailingSlash(u.toString());
  } catch {
    return `https://pymthouse.com${OIDC_MOUNT_PATH}`;
  }
}

/**
 * JWKS URL for the local signer-dmz container (`JWKS_URI`). Must resolve to the
 * same keys as {@link getIssuer} (this app). Loopback hosts are rewritten to
 * `host.docker.internal` so the container can reach the dev server. Override
 * with `SIGNER_DMZ_JWKS_URL` (https or allowed http dev hosts in jwks_to_pem.py).
 */
export function getJwksUrlForLocalSignerDmzContainer(): string {
  const trimmed = process.env.SIGNER_DMZ_JWKS_URL?.trim();
  if (trimmed) return trimmed;
  const u = new URL(`${getIssuer()}/jwks`);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
    u.hostname = "host.docker.internal";
  }
  return u.toString();
}
