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

/**
 * HTML bridge for loopback redirects. Hosted CDNs often mangle `Location:
 * http://localhost…` headers (leaving `http:/`); a same-origin page with an
 * explicit link + copyable URL survives that and matches Claude Code's
 * "paste the redirect URL" fallback.
 */
export function buildLoopbackRedirectBridgeHtml(redirectUrl: URL): string {
  const href = redirectUrl.href;
  const safeHref = href
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const safeText = href
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Return to Claude Code</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #09090b; color: #fafafa;
      display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
    main { max-width: 36rem; padding: 1.5rem; border: 1px solid #27272a; border-radius: 0.75rem;
      background: #18181b; }
    a.button { display: inline-block; margin-top: 1rem; padding: 0.65rem 1rem; border-radius: 0.5rem;
      background: #10b981; color: #052e1b; font-weight: 600; text-decoration: none; }
    pre { margin-top: 1rem; padding: 0.75rem; background: #09090b; border-radius: 0.5rem;
      font-size: 0.75rem; overflow-wrap: anywhere; white-space: pre-wrap; color: #a1a1aa; }
    p { color: #a1a1aa; line-height: 1.5; }
    h1 { font-size: 1.125rem; margin: 0 0 0.5rem; }
  </style>
</head>
<body>
  <main>
    <h1>Authorization complete</h1>
    <p>Return to Claude Code to finish connecting Livepeer MCP. If the app does not open automatically, use the button or paste the URL into the CLI prompt.</p>
    <p><a class="button" id="continue" href="${safeHref}">Return to Claude Code</a></p>
    <pre id="url">${safeText}</pre>
  </main>
  <script>
    (function () {
      var target = ${JSON.stringify(href)};
      try { window.location.replace(target); } catch (e) { /* keep manual link */ }
    })();
  </script>
</body>
</html>`;
}
