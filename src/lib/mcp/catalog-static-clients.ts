import { registerClient } from "@/lib/oidc/clients";
import {
  MCP_CATALOG_CLIENTS,
  MCP_CATALOG_STATIC_REDIRECTS,
  mcpCatalogRegisteredScope,
} from "@/lib/mcp/catalog";

let ensured: Promise<void> | null = null;

/**
 * Public OIDC clients for dashboard Link and Cursor mcp.json CLIENT_ID.
 * Not developer_apps rows and not the platform default app.
 */
export async function ensureMcpCatalogStaticClients(): Promise<void> {
  ensured ??= (async () => {
    for (const client of MCP_CATALOG_CLIENTS) {
      await registerClient({
        clientId: client.staticClientId,
        displayName: client.name,
        redirectUris: MCP_CATALOG_STATIC_REDIRECTS[client.id],
        allowedScopes: mcpCatalogRegisteredScope(),
        grantTypes: ["authorization_code", "refresh_token"],
        tokenEndpointAuthMethod: "none",
      });
    }
  })().catch((err) => {
    ensured = null;
    throw err;
  });
  return ensured;
}
