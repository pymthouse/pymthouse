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

export function validateRedirectUri(
  redirectUri: string,
  allowedUris: string[],
  strictMode: boolean = true
): boolean {
  try {
    const redirectUrl = new URL(redirectUri);
    
    for (const allowedUri of allowedUris) {
      if (allowedUri.includes("*")) {
        // Only allow a single wildcard; reject entries with multiple wildcards
        const wildcardCount = (allowedUri.match(/\*/g) || []).length;
        if (wildcardCount !== 1) continue;

        const starIdx = allowedUri.indexOf("*");
        const prefix = allowedUri.slice(0, starIdx);
        const suffix = allowedUri.slice(starIdx + 1);

        if (prefix && suffix) {
          // Wildcard in the middle (e.g. https://*.example.com/callback):
          // parse URL components to avoid matching across URL boundaries
          try {
            const templateUrl = new URL(allowedUri.replace(/\*/g, "WILDCARD"));
            if (templateUrl.host.includes("WILDCARD")) {
              // Wildcard is in the host component
              const hostSuffix = templateUrl.host.replace("WILDCARD", "");
              if (
                redirectUrl.protocol === templateUrl.protocol &&
                (redirectUrl.host === hostSuffix.replace(/^\./, "") ||
                  redirectUrl.host.endsWith(hostSuffix)) &&
                redirectUrl.pathname === templateUrl.pathname &&
                redirectUrl.search === templateUrl.search
              ) {
                return true;
              }
            } else if (templateUrl.pathname.includes("WILDCARD")) {
              // Wildcard is in the path component
              const pathPrefix = templateUrl.pathname.split("WILDCARD")[0];
              if (
                redirectUrl.protocol === templateUrl.protocol &&
                redirectUrl.host === templateUrl.host &&
                redirectUrl.pathname.startsWith(pathPrefix)
              ) {
                return true;
              }
            }
            // Wildcard in query/fragment — too permissive, skip
          } catch {
            continue;
          }
        } else if (prefix) {
          // Prefix-only wildcard (e.g. "https://*"): compare via URL href
          if (redirectUrl.href.startsWith(prefix)) return true;
        } else if (suffix) {
          // Suffix-only wildcard (e.g. "*.example.com"): compare host component only
          if (
            redirectUrl.host === suffix.replace(/^\./, "") ||
            redirectUrl.host.endsWith(suffix)
          ) {
            return true;
          }
        }
      } else if (redirectUri === allowedUri) {
        return true;
      } else if (!strictMode) {
        try {
          const allowedUrl = new URL(allowedUri);
          if (redirectUrl.origin === allowedUrl.origin && 
              redirectUrl.pathname === allowedUrl.pathname) {
            return true;
          }
        } catch {
          continue;
        }
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
