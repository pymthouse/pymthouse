/**
 * Shared redirect policy for MCP dynamic clients (DCR + final redirect).
 *
 * Keeping this logic centralized avoids drift between registration-time
 * metadata checks and authorization-time redirect enforcement.
 */

const CLAUDE_MCP_REDIRECT_ORIGINS = new Set([
  "https://claude.ai",
  "https://claude.com",
]);

const CLAUDE_MCP_CALLBACK_PATH = "/api/mcp/auth_callback";

/**
 * RFC 8252 loopback redirects used by Claude Code and other native MCP clients.
 */
export function isLoopbackMcpRedirectUrl(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
    return false;
  }
  return url.pathname === "/callback" || url.pathname.endsWith("/callback");
}

/**
 * Hosted Claude callback redirects.
 */
export function isClaudeHostedMcpRedirectUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    CLAUDE_MCP_REDIRECT_ORIGINS.has(url.origin) &&
    url.pathname === CLAUDE_MCP_CALLBACK_PATH
  );
}

/**
 * Redirect targets explicitly permitted for open MCP dynamic clients.
 */
export function isPermittedMcpDynamicRedirect(url: URL): boolean {
  return isLoopbackMcpRedirectUrl(url) || isClaudeHostedMcpRedirectUrl(url);
}

/**
 * Registration-time validator for `redirect_uris` metadata in DCR payloads.
 */
export function isAllowedMcpDcrRedirectUri(uri: string): boolean {
  try {
    return isPermittedMcpDynamicRedirect(new URL(uri));
  } catch {
    return false;
  }
}
