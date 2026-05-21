import { headers } from "next/headers";
import { getAppByCustomDomain, getTrustedLoginHosts, normalizeDomain } from "./custom-domains";
import { resolveAppBrandingByAppId, getDefaultBranding, AppBranding } from "./branding";
import { getPublicOrigin } from "./issuer-urls";

export interface HostContext {
  requestHost: string;
  isCustomDomain: boolean;
  isTrustedHost: boolean;
  appId: string | null;
  branding: AppBranding;
  canonicalOrigin: string;
}

export async function resolveHostContext(): Promise<HostContext> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host");
  const hostHeader = requestHeaders.get("host");
  const requestHost = forwardedHost || hostHeader || "localhost";

  if (!forwardedHost && !hostHeader) {
    console.warn("[host-resolution] No host header found, falling back to localhost");
  }

  const canonicalOrigin = getPublicOrigin();
  const canonicalHost = new URL(canonicalOrigin).host;

  const normalizedRequestHost = normalizeDomain(requestHost);
  const normalizedCanonicalHost = normalizeDomain(canonicalHost);

  const isCanonicalHost = normalizedRequestHost === normalizedCanonicalHost;
  const trustedHosts = await getTrustedLoginHosts();
  const isTrustedHost = trustedHosts.some(
    (h) => normalizeDomain(h) === normalizedRequestHost,
  );

  if (isCanonicalHost) {
    return {
      requestHost,
      isCustomDomain: false,
      isTrustedHost: true,
      appId: null,
      branding: getDefaultBranding(),
      canonicalOrigin,
    };
  }

  const app = await getAppByCustomDomain(requestHost);

  if (app) {
    return {
      requestHost,
      isCustomDomain: true,
      isTrustedHost: true,
      appId: app.id,
      branding: await resolveAppBrandingByAppId(app.id),
      canonicalOrigin,
    };
  }

  return {
    requestHost,
    isCustomDomain: false,
    isTrustedHost,
    appId: null,
    branding: getDefaultBranding(),
    canonicalOrigin,
  };
}

export function buildUrlForHost(
  path: string,
  hostContext: HostContext,
  useCanonical: boolean = false,
): string {
  const origin = useCanonical ? hostContext.canonicalOrigin : `https://${hostContext.requestHost}`;
  return `${origin}${path}`;
}

export function shouldForceCanonicalIssuer(_hostContext: HostContext): boolean {
  return true;
}
