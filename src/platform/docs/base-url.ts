/**
 * Public Mintlify docs (https://docs.pymthouse.com) — not served from this repo.
 * Override with NEXT_PUBLIC_DOCS_URL for previews or forks.
 *
 * Integration guides use paths like `/integration/device-flow` and
 * `/integration/interactive-login` (see https://docs.pymthouse.com/llms.txt).
 */
export function getDocsBaseUrl(): string {
  const defaultDocsUrl = "https://docs.pymthouse.com";
  const fromEnv = process.env.NEXT_PUBLIC_DOCS_URL?.trim().replace(/\/+$/, "");
  if (!fromEnv) return defaultDocsUrl;

  try {
    const url = new URL(fromEnv);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return fromEnv;
    }
  } catch {
    /* fall through to default */
  }

  return defaultDocsUrl;
}

/** Stable paths on the docs site (see docs.pymthouse.com/llms.txt). */
export function docsDeviceFlowUrl(): string {
  return `${getDocsBaseUrl()}/integration/device-flow`;
}

/** OAuth 2.0 authorization code + PKCE (browser redirect flow). */
export function docsInteractiveLoginUrl(): string {
  return `${getDocsBaseUrl()}/integration/interactive-login`;
}

/** OIDC discovery, issuer layout, and API surface overview (not under /integration/*). */
export function docsOidcUrl(): string {
  return `${getDocsBaseUrl()}/api-reference/introduction`;
}
