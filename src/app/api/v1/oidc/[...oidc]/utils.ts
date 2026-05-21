import { PROVIDER_ENDPOINT_PATHS } from "@/platform/oidc/routes";
import { OIDC_MOUNT_PATH, getPublicOrigin } from "@/platform/oidc/issuer-urls";

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
  const { getTrustedLoginHosts } = await import("@/domains/oidc-platform/runtime/custom-domains");
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

export function resolveRedirectLocation(
  location: string,
  origin: string,
  allowedOrigins?: Set<string>,
): URL {
  if (/^https?:\/\//i.test(location)) {
    const redirectUrl = new URL(location);
    if (allowedOrigins && !allowedOrigins.has(redirectUrl.origin)) {
      throw new Error(`[OIDC] Redirect to unregistered origin blocked: ${redirectUrl.origin}`);
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
