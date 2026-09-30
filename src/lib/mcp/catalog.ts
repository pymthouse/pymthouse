/**
 * Platform catalog of built-in MCP clients every signed-in user sees.
 *
 * This is not a developer_apps row per user and not copies of the platform
 * default app. Identity is inferred from CIMD URLs, DCR redirects, or the
 * static Cursor public client id used in mcp.json.
 */

import { isAllowedCimdClientId } from "@/lib/oidc/cimd";
import {
  isClaudeHostedMcpRedirectUrl,
  isCursorMcpRedirectUrl,
} from "@/lib/oidc/mcp-dynamic-redirects";
import { MCP_RESOURCE_SCOPES } from "@/lib/mcp/oauth-resource";

export const MCP_CATALOG_CLIENT_IDS = [
  "claude",
  "hermes",
  "codex",
  "chatgpt",
  "cursor",
] as const;

export type McpCatalogClientId = (typeof MCP_CATALOG_CLIENT_IDS)[number];

/** Static public OIDC client_id for Cursor mcp.json `CLIENT_ID`. */
export const MCP_CURSOR_STATIC_CLIENT_ID = "mcp_cursor";

const STATIC_CLIENT_IDS: Record<McpCatalogClientId, string> = {
  claude: "mcp_claude",
  hermes: "mcp_hermes",
  codex: "mcp_codex",
  chatgpt: "mcp_chatgpt",
  cursor: MCP_CURSOR_STATIC_CLIENT_ID,
};

export type McpCatalogClientStatus = {
  id: McpCatalogClientId;
  name: string;
  linked: boolean;
  mcpUrl: string;
  staticClientId: string;
};

export const MCP_CATALOG_CLIENTS: ReadonlyArray<{
  id: McpCatalogClientId;
  name: string;
  staticClientId: string;
}> = [
  { id: "claude", name: "Claude", staticClientId: STATIC_CLIENT_IDS.claude },
  { id: "hermes", name: "Hermes", staticClientId: STATIC_CLIENT_IDS.hermes },
  { id: "codex", name: "Codex", staticClientId: STATIC_CLIENT_IDS.codex },
  { id: "chatgpt", name: "ChatGPT", staticClientId: STATIC_CLIENT_IDS.chatgpt },
  { id: "cursor", name: "Cursor", staticClientId: STATIC_CLIENT_IDS.cursor },
];

const STATIC_ID_TO_CATALOG = new Map(
  MCP_CATALOG_CLIENTS.map((client) => [client.staticClientId, client.id]),
);

export function isMcpCatalogClientId(value: string): value is McpCatalogClientId {
  return (MCP_CATALOG_CLIENT_IDS as readonly string[]).includes(value);
}

export function isMcpCatalogStaticClientId(clientId: string): boolean {
  return STATIC_ID_TO_CATALOG.has(clientId);
}

export function catalogClientFromStaticId(
  clientId: string,
): McpCatalogClientId | null {
  return STATIC_ID_TO_CATALOG.get(clientId) ?? null;
}

export function staticClientIdForCatalog(
  id: McpCatalogClientId,
): string {
  return STATIC_CLIENT_IDS[id];
}

export function catalogClientDisplayName(id: McpCatalogClientId): string {
  return MCP_CATALOG_CLIENTS.find((client) => client.id === id)?.name ?? id;
}

export function catalogClientFromCimdUrl(
  clientId: string,
): McpCatalogClientId | null {
  if (!isAllowedCimdClientId(clientId)) return null;
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    return null;
  }
  if (parsed.hostname === "claude.ai" || parsed.hostname === "claude.com") {
    return "claude";
  }
  if (parsed.hostname === "nousresearch.github.io") {
    return "hermes";
  }
  if (parsed.hostname === "chatgpt.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[1] === "codex") return "codex";
    return "chatgpt";
  }
  return null;
}

function catalogClientFromRedirectUri(uri: string): McpCatalogClientId | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (isClaudeHostedMcpRedirectUrl(parsed)) return "claude";
  if (isCursorMcpRedirectUrl(parsed)) return "cursor";
  if (
    parsed.protocol === "https:" &&
    parsed.hostname === "chatgpt.com" &&
    (parsed.pathname === "/connector_platform_oauth_redirect" ||
      parsed.pathname.startsWith("/connector/oauth/"))
  ) {
    return "chatgpt";
  }
  return null;
}

export function catalogClientFromRedirectUris(
  redirectUris: string[] | undefined | null,
): McpCatalogClientId | null {
  if (!redirectUris?.length) return null;
  for (const uri of redirectUris) {
    const id = catalogClientFromRedirectUri(uri);
    if (id) return id;
  }
  return null;
}

export function catalogClientFromName(
  clientName: string | undefined | null,
): McpCatalogClientId | null {
  if (!clientName) return null;
  const name = clientName.toLowerCase();
  if (name.includes("claude")) return "claude";
  if (name.includes("hermes")) return "hermes";
  if (name.includes("codex")) return "codex";
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  if (name.includes("cursor")) return "cursor";
  return null;
}

export function identifyMcpCatalogClient(input: {
  clientId: string;
  redirectUris?: string[] | null;
  clientName?: string | null;
}): McpCatalogClientId | null {
  const fromStatic = catalogClientFromStaticId(input.clientId);
  if (fromStatic) return fromStatic;
  const fromCimd = catalogClientFromCimdUrl(input.clientId);
  if (fromCimd) return fromCimd;
  const fromRedirects = catalogClientFromRedirectUris(input.redirectUris);
  if (fromRedirects) return fromRedirects;
  return catalogClientFromName(input.clientName);
}

export function isMcpOAuthPublicClientId(clientId: string): boolean {
  return (
    clientId.startsWith("dcr_") ||
    isAllowedCimdClientId(clientId) ||
    isMcpCatalogStaticClientId(clientId)
  );
}

export const MCP_CATALOG_STATIC_REDIRECTS: Record<McpCatalogClientId, string[]> = {
  claude: [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "http://127.0.0.1/callback",
    "http://localhost/callback",
    "http://[::1]/callback",
  ],
  hermes: [
    "http://127.0.0.1/callback",
    "http://localhost/callback",
    "http://[::1]/callback",
  ],
  codex: [
    "http://127.0.0.1/callback",
    "http://localhost/callback",
    "http://[::1]/callback",
  ],
  chatgpt: [
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "http://127.0.0.1/callback",
    "http://localhost/callback",
  ],
  cursor: [
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "https://cursor.com/agents/mcp/oauth/callback",
    "http://127.0.0.1/callback",
    "http://localhost/callback",
    "http://localhost:8787/callback",
    "http://[::1]/callback",
  ],
};

export function mcpCatalogRegisteredScope(): string {
  return MCP_RESOURCE_SCOPES.join(" ");
}
