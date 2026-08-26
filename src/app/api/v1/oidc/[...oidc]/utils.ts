import { PROVIDER_ENDPOINT_PATHS } from "@/lib/oidc/routes";
import { OIDC_MOUNT_PATH, getPublicOrigin } from "@/lib/oidc/issuer-urls";
import {
  isLoopbackMcpRedirectUrl,
  isPermittedMcpDynamicRedirect,
} from "@/lib/oidc/mcp-dynamic-redirects";

export function deriveExternalOriginFromHeaders(headers: Headers): string {
  const publicFallback = getPublicOrigin();
  const xfHostRaw = headers.get("x-forwarded-host");
  if (!xfHostRaw) return publicFallback;

  const xfProtoRaw = headers.get("x-forwarded-proto");
  const host = xfHostRaw.split(",")[0]?.trim();
  const protoCandidate = xfProtoRaw?.split(",")[0]?.trim().toLowerCase();
  const proto =
    protoCandidate === "http" || protoCandidate === "https"
      ? protoCandidate
      : new URL(publicFallback).protocol.replace(":", "");

  if (!host) return publicFallback;
  return `${proto}://${host}`;
}

/**
 * Origins allowed for OIDC redirects alongside registered client redirect URIs.
 * Includes the public issuer origin plus hosts from `getTrustedLoginHosts()`; custom login
 * hostnames come only from `getVerifiedCustomLoginDomainHosts()` (enabled + DNS-verified),
 * never unverified custom domains.
 */
export async function getTrustedOidcOrigins(): Promise<Set<string>> {
  const publicOrigin = getPublicOrigin();
  const { getTrustedLoginHosts } = await import("@/lib/oidc/custom-domains");
  const trustedHosts = await getTrustedLoginHosts();

  const origins = new Set<string>();
  origins.add(new URL(publicOrigin).origin);

  for (const host of trustedHosts) {
    if (host.includes("localhost") || host.startsWith("127.")) {
      origins.add(`http://${host}`);
    } else {
      origins.add(`https://${host}`);
    }
  }

  return origins;
}

/** RFC 8252 loopback — Claude Code / native MCP clients. */
export function isLoopbackHttpRedirect(url: URL): boolean {
  return isLoopbackMcpRedirectUrl(url);
}

/**
 * Re-encode an absolute OAuth redirect so query values use %XX (not bare `+`).
 *
 * `URLSearchParams` / HTML navigations treat bare `+` as space, which breaks
 * Claude Code `state` verification ("Invalid state parameter"). Provider
 * Locations are usually already encoded; this is idempotent for `%2B` and
 * repairs bare `+` if a hop decoded them.
 */
export function reencodeOAuthRedirectLocation(absoluteUrl: string): string {
  const trimmed = absoluteUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("[OIDC] reencodeOAuthRedirectLocation requires an absolute URL");
  }

  const parsed = new URL(trimmed);
  const qIndex = trimmed.indexOf("?");
  if (qIndex < 0) {
    return parsed.href;
  }

  let query = trimmed.slice(qIndex + 1);
  let hash = "";
  const hashIndex = query.indexOf("#");
  if (hashIndex >= 0) {
    hash = query.slice(hashIndex);
    query = query.slice(0, hashIndex);
  }

  const params = new URLSearchParams();
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const encKey = eq >= 0 ? part.slice(0, eq) : part;
    const encVal = eq >= 0 ? part.slice(eq + 1) : "";
    // Treat bare `+` as a literal plus (OAuth state/code), not a space.
    const key = decodeURIComponent(encKey.replaceAll("+", "%2B"));
    const val = decodeURIComponent(encVal.replaceAll("+", "%2B"));
    params.append(key, val);
  }

  return `${parsed.origin}${parsed.pathname}?${params.toString()}${hash}`;
}

export function resolveRedirectLocation(
  location: string,
  origin: string,
  allowedOrigins?: Set<string>,
): URL {
  if (/^https?:\/\//i.test(location)) {
    const redirectUrl = new URL(location);
    if (
      allowedOrigins &&
      !allowedOrigins.has(redirectUrl.origin) &&
      !isPermittedMcpDynamicRedirect(redirectUrl)
    ) {
      throw new Error(
        `[OIDC] Redirect to unregistered origin blocked: ${redirectUrl.origin}`,
      );
    }
    return redirectUrl;
  }

  if (
    location.startsWith("/") &&
    !location.startsWith(OIDC_MOUNT_PATH) &&
    Object.values(PROVIDER_ENDPOINT_PATHS).some((path) => location.startsWith(path))
  ) {
    return new URL(`${OIDC_MOUNT_PATH}${location}`, origin);
  }

  return new URL(location, origin);
}
