/**
 * Helpers for Open Dynamic Client Registration (RFC 7591) used by Claude MCP.
 */

import { errors } from "oidc-provider";
import type { KoaContextWithOIDC } from "oidc-provider";
import { MCP_RESOURCE_SCOPES } from "@/lib/mcp/oauth-resource";
import { isAllowedMcpDcrRedirectUri } from "./mcp-dynamic-redirects";

/** Prefix for DCR-issued client_ids so interaction / consent can detect them. */
export const DCR_CLIENT_ID_PREFIX = "dcr_";

/**
 * Scopes a DCR (MCP) client may register, request, display on consent, and be
 * granted. Must stay aligned with consent UI filtering.
 */
export const DCR_ALLOWED_SCOPES: readonly string[] = [...MCP_RESOURCE_SCOPES];

export function isDcrClientId(clientId: string): boolean {
  return clientId.startsWith(DCR_CLIENT_ID_PREFIX);
}

export function createDcrClientId(): string {
  return `${DCR_CLIENT_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

export { isAllowedMcpDcrRedirectUri };

/** Split an OAuth scope string into unique tokens. */
export function parseScopeParam(scope: string | undefined | null): string[] {
  if (!scope || typeof scope !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of scope.split(/[\s,]+/)) {
    const scopeToken = token.trim();
    if (!scopeToken || seen.has(scopeToken)) continue;
    seen.add(scopeToken);
    out.push(scopeToken);
  }
  return out;
}

/**
 * Intersect requested scopes with an allowlist (preserves request order).
 * Used so consent grants only what the UI shows / the client may hold.
 */
export function filterScopesToAllowlist(
  requested: string | string[] | undefined | null,
  allowlist: readonly string[],
): string[] {
  const requestedList = Array.isArray(requested)
    ? requested.map((s) => s.trim()).filter(Boolean)
    : parseScopeParam(requested);
  const allowed = new Set(allowlist);
  return requestedList.filter((scope) => allowed.has(scope));
}

/** Normalize interaction / authorize scope params (string, list, or Set). */
export function requestedScopeInput(
  requested: unknown,
): string | string[] | undefined {
  if (requested instanceof Set) {
    return [...requested].filter((scope): scope is string => typeof scope === "string");
  }
  if (typeof requested === "string") return requested;
  if (Array.isArray(requested)) {
    return requested.filter((scope): scope is string => typeof scope === "string");
  }
  return undefined;
}

/**
 * Scopes written onto the consent Grant. DCR requests that omit `scope` on the
 * interaction still get the MCP allowlist so resume cannot finish empty and
 * redirect `error=access_denied` (no description).
 */
export function resolveGrantedConsentScopes(
  requested: unknown,
  allowlist: readonly string[],
  clientId: string,
): string {
  const filtered = filterScopesToAllowlist(
    requestedScopeInput(requested),
    allowlist,
  ).join(" ");
  if (filtered) return filtered;
  if (isDcrClientId(clientId) && allowlist.length > 0) {
    return allowlist.join(" ");
  }
  return "";
}

/** Fixed scope string written onto every MCP DCR client registration. */
export function mcpDcrRegisteredScope(): string {
  return DCR_ALLOWED_SCOPES.join(" ");
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

  // Never trust client-supplied scopes: a malicious DCR registrant could
  // otherwise advertise admin/users:write and receive them at consent time.
  properties.scope = mcpDcrRegisteredScope();
}
