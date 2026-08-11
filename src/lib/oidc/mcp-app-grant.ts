/**
 * Persist the Builder app chosen at MCP OAuth consent onto the OIDC grant so
 * access / refresh token issuance can stamp `pymthouse_app` via extraTokenClaims.
 */

import type { AdapterPayload } from "oidc-provider";

import { PostgresOidcAdapter } from "@/lib/oidc/adapter";

const MODEL = "McpAppGrant";
/** Align with Grant TTL (14 days). */
const BINDING_TTL_SECONDS = 14 * 24 * 3600;

export type McpAppGrantBinding = {
  accountId: string;
  publicClientId: string;
  developerAppId: string;
};

export async function bindMcpAppToGrant(
  grantId: string,
  binding: McpAppGrantBinding,
): Promise<void> {
  const adapter = new PostgresOidcAdapter(MODEL);
  const payload = {
    accountId: binding.accountId,
    publicClientId: binding.publicClientId,
    developerAppId: binding.developerAppId,
  } as AdapterPayload;
  await adapter.upsert(grantId, payload, BINDING_TTL_SECONDS);
}

export async function findMcpAppGrantBinding(
  grantId: string,
): Promise<McpAppGrantBinding | null> {
  const adapter = new PostgresOidcAdapter(MODEL);
  const payload = await adapter.find(grantId);
  if (!payload) return null;
  const row = payload as AdapterPayload & Partial<McpAppGrantBinding>;
  const accountId =
    typeof row.accountId === "string" ? row.accountId : null;
  const publicClientId =
    typeof row.publicClientId === "string" ? row.publicClientId : null;
  const developerAppId =
    typeof row.developerAppId === "string" ? row.developerAppId : null;
  if (!accountId || !publicClientId || !developerAppId) return null;
  return { accountId, publicClientId, developerAppId };
}
