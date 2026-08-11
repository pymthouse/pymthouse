import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appAllowedDomains, developerApps, oidcClients } from "@/db/schema";
import { normalizeDomainWhitelist } from "@/lib/domain-whitelist";

const KONG_PORTALS_SUFFIX = ".kongportals.com";
const APP_SCOPED_API_PATH_RE = /^\/api\/v1\/apps\/([^/]+)/;

/** Unauthenticated platform metadata paths may use any tenant allowlisted origin. */
const PLATFORM_METADATA_CORS_PATH_RES = [
  /^\/api\/v1\/health(?:\/|$)/,
  /^\/api\/v1\/docs(?:\/|$)/,
  /^\/api\/v1\/mcp$/,
  /^\/api\/v1\/pipeline-catalog(?:\/|$)/,
  /^\/api\/v1\/openapi\.json$/,
  /^\/api\/v1\/internal\/(?:docs|openapi\.json)(?:\/|$)/,
  /^\/api\/v1\/marketplace(?:\/|$)/,
] as const;

export type ApiCorsResolveInput = {
  configuredOrigins: string[];
  nextAuthUrl?: string | null;
};

/** Split `PYMTHOUSE_API_CORS_ORIGINS` (or similar) CSV into absolute origins. */
export function readConfiguredCorsOrigins(
  raw: string | undefined | null,
): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

/**
 * Localhost Origin bypass for app-scoped CORS.
 * Allowed outside production, or when `PYMTHOUSE_API_CORS_ALLOW_LOCALHOST=1`.
 */
export function allowLocalhostCorsOrigin(origin: string): boolean {
  if (!isLocalhostOrigin(origin)) return false;
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.PYMTHOUSE_API_CORS_ALLOW_LOCALHOST === "1";
}

function isPlatformMetadataCorsPath(pathname: string): boolean {
  return PLATFORM_METADATA_CORS_PATH_RES.some((re) => re.test(pathname));
}

function canonicalOriginKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = normalizeDomainWhitelist(trimmed);
  if (normalized.success) {
    return normalized.normalized.toLowerCase();
  }
  if (URL.canParse(trimmed)) {
    return trimmed.toLowerCase();
  }
  return null;
}

/** True for `https://*.kongportals.com` (exact suffix match; rejects lookalikes). */
export function isKongPortalsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "kongportals.com" || host.endsWith(KONG_PORTALS_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * Platform-level CORS allow (no app context): env list, NEXTAUTH_URL origin,
 * localhost (non-prod / opt-in), and Kong Dev Portal hosts.
 */
export function resolveApiCorsAllowOrigin(
  origin: string | null | undefined,
  input: ApiCorsResolveInput,
): string | null {
  if (!origin?.trim()) return null;
  const trimmed = origin.trim();

  if (!URL.canParse(trimmed)) {
    return null;
  }

  if (input.configuredOrigins.includes(trimmed)) {
    return trimmed;
  }

  const nextAuth = input.nextAuthUrl?.trim();
  if (nextAuth) {
    try {
      if (new URL(nextAuth).origin === trimmed) {
        return trimmed;
      }
    } catch {
      /* ignore */
    }
  }

  if (allowLocalhostCorsOrigin(trimmed)) {
    return trimmed;
  }

  if (isKongPortalsOrigin(trimmed)) {
    return trimmed;
  }

  return null;
}

export function buildApiCorsHeaders(allowOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, MCP-Session-Id, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "MCP-Session-Id, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * Match Origin against stored allowlist entries.
 * Accepts either a full origin or a bare host on either side (normalized via
 * {@link normalizeDomainWhitelist}).
 */
export function originMatchesAppDomains(
  origin: string,
  domains: string[],
): boolean {
  const originKey = canonicalOriginKey(origin);
  if (!originKey) return false;
  return domains.some((d) => {
    const storedKey = canonicalOriginKey(d);
    return storedKey !== null && storedKey === originKey;
  });
}

let _appCorsCache: {
  byAppKey: Map<string, string[]>;
  allOrigins: string[];
  expiry: number;
} | null = null;
const APP_CORS_CACHE_TTL_MS = 60_000;

async function loadAppCorsSnapshot(): Promise<{
  byAppKey: Map<string, string[]>;
  allOrigins: string[];
}> {
  const now = Date.now();
  if (_appCorsCache && now < _appCorsCache.expiry) {
    return _appCorsCache;
  }

  const rows = await db
    .select({
      appId: developerApps.id,
      publicClientId: oidcClients.clientId,
      domain: appAllowedDomains.domain,
    })
    .from(appAllowedDomains)
    .innerJoin(developerApps, eq(appAllowedDomains.appId, developerApps.id))
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id));

  const byAppKey = new Map<string, string[]>();
  const allOrigins: string[] = [];
  for (const row of rows) {
    for (const key of [row.publicClientId, row.appId]) {
      const list = byAppKey.get(key) ?? [];
      list.push(row.domain);
      byAppKey.set(key, list);
    }
    allOrigins.push(row.domain);
  }

  _appCorsCache = {
    byAppKey,
    allOrigins,
    expiry: now + APP_CORS_CACHE_TTL_MS,
  };
  return _appCorsCache;
}

/** Drop TTL cache after domain whitelist mutations. */
export function invalidateAppCorsCache(): void {
  _appCorsCache = null;
}

/**
 * Resolve ACAO for a Builder API request.
 *
 * - `/api/v1/apps/{clientId}/…` → Origin must be on **that app's** domain allowlist
 *   (App Settings), or localhost for local tooling (non-production / opt-in).
 * - Other `/api/v1/…` → platform allow (env / NEXTAUTH / localhost / `*.kongportals.com`).
 * - Tenant-shared allowlist fallback applies only to public metadata paths.
 */
export async function resolveBuilderApiCorsOrigin(
  origin: string | null | undefined,
  pathname: string,
): Promise<string | null> {
  if (!origin?.trim()) {
    return null;
  }
  const trimmed = origin.trim();

  const appMatch = APP_SCOPED_API_PATH_RE.exec(pathname);
  if (appMatch) {
    if (allowLocalhostCorsOrigin(trimmed)) {
      return trimmed;
    }
    let appKey: string;
    try {
      appKey = decodeURIComponent(appMatch[1]!);
    } catch {
      return null;
    }
    const snapshot = await loadAppCorsSnapshot();
    const domains = snapshot.byAppKey.get(appKey) ?? [];
    if (originMatchesAppDomains(trimmed, domains)) {
      return trimmed;
    }
    return null;
  }

  const platform = resolveApiCorsAllowOrigin(trimmed, {
    configuredOrigins: readConfiguredCorsOrigins(
      process.env.PYMTHOUSE_API_CORS_ORIGINS,
    ),
    nextAuthUrl: process.env.NEXTAUTH_URL,
  });
  if (platform) {
    return platform;
  }

  if (!isPlatformMetadataCorsPath(pathname)) {
    return null;
  }

  const snapshot = await loadAppCorsSnapshot();
  if (originMatchesAppDomains(trimmed, snapshot.allOrigins)) {
    return trimmed;
  }
  return null;
}
