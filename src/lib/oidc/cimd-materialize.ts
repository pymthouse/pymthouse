/**
 * Materialize an allowlisted CIMD client into the OIDC adapter so
 * node-oidc-provider Client.find succeeds with Console fetch guards.
 */

import { errors } from "oidc-provider";
import type { AdapterPayload } from "oidc-provider";

import { mcpCatalogRegisteredScope } from "@/lib/mcp/catalog";
import { PostgresOidcAdapter } from "@/lib/oidc/adapter";
import { resolveCimdClient } from "@/lib/oidc/cimd";
import { catalogClientFromCimdUrl, catalogClientDisplayName } from "@/lib/mcp/catalog";

const CIMD_CLIENT_TTL_SECONDS = 60;

export async function materializeCimdClient(clientId: string): Promise<void> {
  const result = await resolveCimdClient(clientId);
  if (!result.ok) {
    if (result.error === "temporarily_unavailable") {
      throw new errors.TemporarilyUnavailable();
    }
    throw new errors.InvalidClient();
  }

  const catalog = catalogClientFromCimdUrl(clientId);
  const payload = {
    client_id: clientId,
    client_name: catalog
      ? catalogClientDisplayName(catalog)
      : "MCP Connector",
    redirect_uris: result.client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "native",
    scope: mcpCatalogRegisteredScope(),
  } as AdapterPayload;

  await new PostgresOidcAdapter("Client").upsert(
    clientId,
    payload,
    CIMD_CLIENT_TTL_SECONDS,
  );
}
