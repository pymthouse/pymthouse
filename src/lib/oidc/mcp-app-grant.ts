/**
 * Persist the Builder app (or platform-default catalog bind) chosen at MCP
 * OAuth consent onto the OIDC grant so access / refresh token issuance can
 * stamp `pymthouse_app` via extraTokenClaims.
 */

import type { AdapterPayload } from "oidc-provider";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db/index";
import { oidcPayloads } from "@/db/schema";
import type { McpCatalogClientId } from "@/lib/mcp/catalog";
import { PostgresOidcAdapter } from "@/lib/oidc/adapter";

const MODEL = "McpAppGrant";
/** Align with Grant TTL (14 days). */
const BINDING_TTL_SECONDS = 14 * 24 * 3600;

export type McpAppGrantBinding = {
  accountId: string;
  publicClientId: string;
  developerAppId: string;
  catalogClientId?: McpCatalogClientId;
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
    ...(binding.catalogClientId
      ? { catalogClientId: binding.catalogClientId }
      : {}),
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
  const catalogClientId =
    row.catalogClientId === "claude" ||
    row.catalogClientId === "hermes" ||
    row.catalogClientId === "codex" ||
    row.catalogClientId === "chatgpt" ||
    row.catalogClientId === "cursor"
      ? row.catalogClientId
      : undefined;
  return { accountId, publicClientId, developerAppId, catalogClientId };
}

export type McpAppGrantBindingRow = McpAppGrantBinding & {
  grantId: string;
};

export async function listMcpAppGrantBindingsForUser(
  accountId: string,
): Promise<McpAppGrantBindingRow[]> {
  const trimmed = accountId.trim();
  if (!trimmed) return [];
  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: oidcPayloads.id,
      payload: oidcPayloads.payload,
    })
    .from(oidcPayloads)
    .where(
      and(
        eq(oidcPayloads.model, MODEL),
        sql`(${oidcPayloads.payload})::jsonb->>'accountId' = ${trimmed}`,
        or(isNull(oidcPayloads.expiresAt), gt(oidcPayloads.expiresAt, now)),
      ),
    );

  const out: McpAppGrantBindingRow[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const binding = parsed as Partial<McpAppGrantBinding>;
    if (
      typeof binding.accountId !== "string" ||
      typeof binding.publicClientId !== "string" ||
      typeof binding.developerAppId !== "string"
    ) {
      continue;
    }
    const catalogClientId =
      binding.catalogClientId === "claude" ||
      binding.catalogClientId === "hermes" ||
      binding.catalogClientId === "codex" ||
      binding.catalogClientId === "chatgpt" ||
      binding.catalogClientId === "cursor"
        ? binding.catalogClientId
        : undefined;
    out.push({
      grantId: row.id,
      accountId: binding.accountId,
      publicClientId: binding.publicClientId,
      developerAppId: binding.developerAppId,
      catalogClientId,
    });
  }
  return out;
}
