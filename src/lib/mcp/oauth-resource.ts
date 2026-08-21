/**
 * MCP OAuth protected-resource helpers (RFC 9728).
 */

import { getIssuer, getPublicOrigin } from "@/lib/oidc/issuer-urls";

export const MCP_OAUTH_APP_CLAIM = "pymthouse_app";

/** Hosted MCP resource identifier — must match the URL users paste into Claude. */
export function getMcpResourceUrl(): string {
  return `${getPublicOrigin()}/api/v1/mcp`;
}

/** Read RFC 8707 `resource` from an OIDC interaction / authorize params object. */
export function readResourceParam(params: Record<string, unknown>): string | null {
  const resource = params.resource;
  if (typeof resource === "string" && resource.trim()) return resource.trim();
  if (Array.isArray(resource)) {
    const first = resource.find((r) => typeof r === "string" && r.trim());
    return typeof first === "string" ? first.trim() : null;
  }
  return null;
}

export function isMcpResourceIndicator(resource: string): boolean {
  const expected = getMcpResourceUrl();
  try {
    return new URL(resource).href === new URL(expected).href;
  } catch {
    return resource === expected;
  }
}

/** Scopes Claude (and other MCP clients) may request for the hosted MCP. */
export const MCP_RESOURCE_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "sign:job",
] as const;

export function buildMcpProtectedResourceMetadata(): Record<string, unknown> {
  const resource = getMcpResourceUrl();
  return {
    resource,
    authorization_servers: [getIssuer()],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_RESOURCE_SCOPES],
    resource_documentation: `${getPublicOrigin()}/api/v1/mcp`,
  };
}

/**
 * RFC 6750 / MCP authorization challenge pointing at protected resource metadata.
 */
export function buildMcpWwwAuthenticateHeader(options?: {
  scope?: string;
  error?: string;
  errorDescription?: string;
}): string {
  const metadataUrl = `${getPublicOrigin()}/.well-known/oauth-protected-resource/api/v1/mcp`;
  const parts = [
    "Bearer",
    `realm="livepeer-mcp"`,
    `resource_metadata="${metadataUrl}"`,
  ];
  if (options?.scope) {
    parts.push(`scope="${options.scope}"`);
  }
  if (options?.error) {
    parts.push(`error="${options.error}"`);
  }
  if (options?.errorDescription) {
    parts.push(
      `error_description="${options.errorDescription.replaceAll('"', "'")}"`,
    );
  }
  return parts.join(" ");
}
