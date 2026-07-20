import { getPublicOrigin, getIssuer } from "./issuer-urls";
import { getTrustedLoginHosts, normalizeDomain } from "./custom-domains";

export interface SecurityContext {
  requestOrigin: string;
  canonicalOrigin: string;
  canonicalIssuer: string;
  isTrustedOrigin: boolean;
  isCanonicalOrigin: boolean;
}

export async function buildSecurityContext(requestHost: string): Promise<SecurityContext> {
  const canonicalOrigin = getPublicOrigin();
  const canonicalIssuer = getIssuer();
  const canonicalHost = new URL(canonicalOrigin).host;

  const normalizedRequestHost = normalizeDomain(requestHost);
  const normalizedCanonicalHost = normalizeDomain(canonicalHost);

  const isCanonicalOrigin = normalizedRequestHost === normalizedCanonicalHost;
  const trustedHosts = await getTrustedLoginHosts();
  const isTrustedOrigin = trustedHosts.some((h) => normalizeDomain(h) === normalizedRequestHost);

  const isLocalhost = requestHost.includes("localhost") || requestHost.startsWith("127.");
  const requestOrigin = isLocalhost ? `http://${requestHost}` : `https://${requestHost}`;

  return {
    requestOrigin,
    canonicalOrigin,
    canonicalIssuer,
    isTrustedOrigin,
    isCanonicalOrigin,
  };
}

function matchesHostWildcard(
  redirectUrl: URL,
  templateUrl: URL,
): boolean {
  const hostSuffix = templateUrl.host.replace("WILDCARD", "");
  return (
    redirectUrl.protocol === templateUrl.protocol &&
    (redirectUrl.host === hostSuffix.replace(/^\./, "") ||
      redirectUrl.host.endsWith(hostSuffix)) &&
    redirectUrl.pathname === templateUrl.pathname &&
    redirectUrl.search === templateUrl.search
  );
}

function matchesPathWildcard(
  redirectUrl: URL,
  templateUrl: URL,
): boolean {
  const pathPrefix = templateUrl.pathname.split("WILDCARD")[0];
  return (
    redirectUrl.protocol === templateUrl.protocol &&
    redirectUrl.host === templateUrl.host &&
    redirectUrl.pathname.startsWith(pathPrefix)
  );
}

function matchesMiddleWildcard(
  redirectUrl: URL,
  allowedUri: string,
): boolean {
  try {
    const templateUrl = new URL(allowedUri.replace(/\*/g, "WILDCARD"));
    if (templateUrl.host.includes("WILDCARD")) {
      return matchesHostWildcard(redirectUrl, templateUrl);
    }
    if (templateUrl.pathname.includes("WILDCARD")) {
      return matchesPathWildcard(redirectUrl, templateUrl);
    }
    // Wildcard in query/fragment — too permissive, skip
    return false;
  } catch {
    return false;
  }
}

function matchesWildcardAllowedUri(
  redirectUrl: URL,
  allowedUri: string,
): boolean {
  // Only allow a single wildcard; reject entries with multiple wildcards
  const wildcardCount = (allowedUri.match(/\*/g) || []).length;
  if (wildcardCount !== 1) return false;

  const starIdx = allowedUri.indexOf("*");
  const prefix = allowedUri.slice(0, starIdx);
  const suffix = allowedUri.slice(starIdx + 1);

  if (prefix && suffix) {
    return matchesMiddleWildcard(redirectUrl, allowedUri);
  }
  if (prefix) {
    // Prefix-only wildcard (e.g. "https://*"): compare via URL href
    return redirectUrl.href.startsWith(prefix);
  }
  if (suffix) {
    // Suffix-only wildcard (e.g. "*.example.com"): compare host component only
    return (
      redirectUrl.host === suffix.replace(/^\./, "") ||
      redirectUrl.host.endsWith(suffix)
    );
  }
  return false;
}

function matchesLooseOriginPath(
  redirectUrl: URL,
  allowedUri: string,
): boolean {
  try {
    const allowedUrl = new URL(allowedUri);
    return (
      redirectUrl.origin === allowedUrl.origin &&
      redirectUrl.pathname === allowedUrl.pathname
    );
  } catch {
    return false;
  }
}

function matchesAllowedUri(
  redirectUri: string,
  redirectUrl: URL,
  allowedUri: string,
  strictMode: boolean,
): boolean {
  if (allowedUri.includes("*")) {
    return matchesWildcardAllowedUri(redirectUrl, allowedUri);
  }
  if (redirectUri === allowedUri) {
    return true;
  }
  if (!strictMode) {
    return matchesLooseOriginPath(redirectUrl, allowedUri);
  }
  return false;
}

export function validateRedirectUri(
  redirectUri: string,
  allowedUris: string[],
  strictMode: boolean = true
): boolean {
  try {
    const redirectUrl = new URL(redirectUri);

    for (const allowedUri of allowedUris) {
      if (matchesAllowedUri(redirectUri, redirectUrl, allowedUri, strictMode)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

export function validatePostLogoutUri(
  postLogoutUri: string,
  allowedUris: string[]
): boolean {
  return validateRedirectUri(postLogoutUri, allowedUris, true);
}

export function sanitizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isSafeRedirectUrl(url: string, allowedOrigins: Set<string>): boolean {
  try {
    const parsed = new URL(url);
    const sanitized = sanitizeOrigin(parsed.origin);
    if (!sanitized) return false;
    return allowedOrigins.has(sanitized);
  } catch {
    return false;
  }
}

export function getCookieOptions(isCustomDomain: boolean): {
  sameSite: "lax" | "none" | "strict";
  secure: boolean;
  httpOnly: boolean;
  path: string;
} {
  const isProduction = process.env.NODE_ENV === "production";
  
  return {
    sameSite: isCustomDomain ? "none" : "lax",
    secure: isProduction || isCustomDomain,
    httpOnly: true,
    path: "/",
  };
}

export function validateCorsOrigin(
  origin: string,
  clientRedirectUris: string[],
  trustedOrigins: Set<string>
): boolean {
  const sanitized = sanitizeOrigin(origin);
  if (!sanitized) return false;

  if (trustedOrigins.has(sanitized)) {
    return true;
  }

  for (const uri of clientRedirectUris) {
    try {
      const uriOrigin = new URL(uri).origin;
      if (sanitized === uriOrigin) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

export async function assertTrustedHost(host: string): Promise<void> {
  const trustedHosts = await getTrustedLoginHosts();
  const normalized = normalizeDomain(host);

  if (!trustedHosts.some((h) => normalizeDomain(h) === normalized)) {
    throw new Error(`Untrusted host: ${host}`);
  }
}

export function getSecureHeaders(isCustomDomain: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };

  if (process.env.NODE_ENV === "production") {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
}
