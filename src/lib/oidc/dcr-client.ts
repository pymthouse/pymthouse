/**
 * Helpers for Open Dynamic Client Registration (RFC 7591) used by Claude MCP.
 */

import { errors } from "oidc-provider";
import type { KoaContextWithOIDC } from "oidc-provider";

/** Prefix for DCR-issued client_ids so interaction / consent can detect them. */
export const DCR_CLIENT_ID_PREFIX = "dcr_";

export function isDcrClientId(clientId: string): boolean {
  return clientId.startsWith(DCR_CLIENT_ID_PREFIX);
}

export function createDcrClientId(): string {
  return `${DCR_CLIENT_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

const CLAUDE_REDIRECT_URIS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

/**
 * Allow Claude hosted callbacks and RFC 8252 loopback redirects (Claude Code).
 * Other https redirect URIs are accepted for non-Claude MCP clients.
 */
export function isAllowedMcpDcrRedirectUri(uri: string): boolean {
  if (CLAUDE_REDIRECT_URIS.has(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol === "http:") {
      const host = u.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
        return u.pathname === "/callback" || u.pathname.endsWith("/callback");
      }
      return false;
    }
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Applied via `extraClientMetadata.validator` on every DCR request (`ctx` set).
 * Forces public-client auth-code + refresh so Claude PKCE works.
 */
export function applyMcpDcrRegistrationPolicy(
  ctx: KoaContextWithOIDC | undefined,
  properties: Record<string, unknown>,
): void {
  // Static clients from `loadClients()` have no ctx — skip enforcement.
  if (!ctx) return;

  const redirects = properties.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0) {
    throw new errors.InvalidClientMetadata("redirect_uris is required");
  }
  for (const uri of redirects) {
    if (typeof uri !== "string" || !isAllowedMcpDcrRedirectUri(uri)) {
      throw new errors.InvalidClientMetadata(
        `redirect_uri not allowed: ${String(uri)}`,
      );
    }
  }

  if (!properties.token_endpoint_auth_method) {
    properties.token_endpoint_auth_method = "none";
  }
  if (properties.token_endpoint_auth_method === "none") {
    delete properties.client_secret;
  }

  properties.grant_types = ["authorization_code", "refresh_token"];
  properties.response_types = ["code"];
  properties.application_type = "native";

  if (!properties.client_name) {
    properties.client_name = "MCP Connector";
  }

  const existingScope =
    typeof properties.scope === "string" ? properties.scope.trim() : "";
  const required = ["openid", "offline_access", "profile", "email"];
  const scopes = new Set(
    [...existingScope.split(/\s+/), ...required].filter(Boolean),
  );
  properties.scope = [...scopes].join(" ");
}
