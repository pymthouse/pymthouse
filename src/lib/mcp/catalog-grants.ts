/**
 * Dashboard Link / Unlink for the five built-in MCP clients.
 *
 * The OAuth grant is the link. Unlink revokes that catalog client's grants
 * only — not personal pmth_* keys or other catalog clients.
 */

import {
  MCP_CATALOG_CLIENTS,
  staticClientIdForCatalog,
  type McpCatalogClientId,
  type McpCatalogClientStatus,
} from "@/lib/mcp/catalog";
import { resolveMcpConsentBinding } from "@/lib/mcp/catalog-consent";
import {
  getMcpResourceUrl,
  MCP_RESOURCE_SCOPES,
} from "@/lib/mcp/oauth-resource";
import { PostgresOidcAdapter } from "@/lib/oidc/adapter";
import { createOidcGrant } from "@/lib/oidc/consent-grant";
import {
  bindMcpAppToGrant,
  listMcpAppGrantBindingsForUser,
} from "@/lib/oidc/mcp-app-grant";
import { getProvider } from "@/lib/oidc/provider";

const GRANTABLE_MODELS = [
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
] as const;

export async function listMcpCatalogClientStatuses(
  userId: string,
): Promise<McpCatalogClientStatus[]> {
  const mcpUrl = getMcpResourceUrl();
  const bindings = await listMcpAppGrantBindingsForUser(userId);
  const live = new Set<McpCatalogClientId>();
  for (const binding of bindings) {
    if (!binding.catalogClientId) continue;
    const grant = await new PostgresOidcAdapter("Grant").find(binding.grantId);
    if (grant) live.add(binding.catalogClientId);
  }

  return MCP_CATALOG_CLIENTS.map((client) => ({
    id: client.id,
    name: client.name,
    linked: live.has(client.id),
    mcpUrl,
    staticClientId: client.staticClientId,
  }));
}

export async function linkMcpCatalogClient(input: {
  userId: string;
  catalogClientId: McpCatalogClientId;
  email?: string | null;
}): Promise<McpCatalogClientStatus> {
  const existing = await listMcpCatalogClientStatuses(input.userId);
  const current = existing.find((row) => row.id === input.catalogClientId);
  if (current?.linked) {
    return current;
  }

  const resolved = await resolveMcpConsentBinding({
    accountId: input.userId,
    clientId: staticClientIdForCatalog(input.catalogClientId),
    clientName: input.catalogClientId,
    email: input.email,
  });
  if (!resolved.ok || resolved.binding?.kind !== "catalog") {
    throw new Error("Failed to bind MCP catalog client to Livepeer Direct");
  }

  const provider = await getProvider();
  const grant = createOidcGrant(
    provider,
    staticClientIdForCatalog(input.catalogClientId),
    input.userId,
  );
  const scopes = MCP_RESOURCE_SCOPES.join(" ");
  grant.addOIDCScope(scopes);
  grant.addResourceScope(getMcpResourceUrl(), scopes);
  const grantId = (await grant.save()) || grant.jti;
  if (!grantId) {
    throw new Error("Failed to persist MCP catalog grant");
  }
  await bindMcpAppToGrant(grantId, {
    accountId: input.userId,
    publicClientId: resolved.binding.publicClientId,
    developerAppId: resolved.binding.developerAppId,
    catalogClientId: input.catalogClientId,
  });

  const updated = await listMcpCatalogClientStatuses(input.userId);
  const row = updated.find((item) => item.id === input.catalogClientId);
  if (!row) {
    throw new Error("MCP catalog client missing after link");
  }
  return row;
}

export async function unlinkMcpCatalogClient(input: {
  userId: string;
  catalogClientId: McpCatalogClientId;
}): Promise<McpCatalogClientStatus> {
  const bindings = await listMcpAppGrantBindingsForUser(input.userId);
  for (const binding of bindings) {
    if (binding.catalogClientId !== input.catalogClientId) continue;
    await revokeMcpGrant(binding.grantId);
  }

  const updated = await listMcpCatalogClientStatuses(input.userId);
  const row = updated.find((item) => item.id === input.catalogClientId);
  if (!row) {
    throw new Error("MCP catalog client missing after unlink");
  }
  return row;
}

async function revokeMcpGrant(grantId: string): Promise<void> {
  await new PostgresOidcAdapter("Grant").destroy(grantId);
  await new PostgresOidcAdapter("McpAppGrant").destroy(grantId);
  for (const model of GRANTABLE_MODELS) {
    await new PostgresOidcAdapter(model).revokeByGrantId(grantId);
  }
}
