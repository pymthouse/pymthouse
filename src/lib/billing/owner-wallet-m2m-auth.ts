import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/db/index";
import { oidcClients } from "@/db/schema";
import { authenticateAppClient } from "@/lib/auth";
import { getProviderApp } from "@/lib/provider-apps";

type ProviderApp = NonNullable<Awaited<ReturnType<typeof getProviderApp>>>;

export type OwnerWalletM2mAccess = {
  app: ProviderApp;
  ownerUserId: string;
};

/**
 * Authorize the owner prepaid wallet surface (`/api/v1/apps/{clientId}/billing/wallet/*`)
 * under Builder M2M Basic only.
 *
 * Resolves the app by the path `{clientId}` and returns the app owner's wallet
 * id. The authenticating client must be this app's configured `m2m_*` backend
 * helper — public / web sibling clients and provider sessions are rejected, so
 * a leaked browser credential can never move owner money. Callers map `null`
 * to 404 (existence is not leaked).
 */
export async function authorizeOwnerWalletM2m(
  request: NextRequest | Request,
  clientId: string,
): Promise<OwnerWalletM2mAccess | null> {
  const trimmed = clientId.trim();
  if (!trimmed) {
    return null;
  }

  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId !== trimmed) {
    return null;
  }

  const app = await getProviderApp(trimmed);
  const ownerUserId = app?.ownerId?.trim();
  if (!app || !ownerUserId || !app.m2mOidcClientId) {
    return null;
  }

  const m2mRows = await db
    .select({ clientId: oidcClients.clientId })
    .from(oidcClients)
    .where(eq(oidcClients.id, app.m2mOidcClientId))
    .limit(1);
  const configuredM2mClientId = m2mRows[0]?.clientId?.trim();
  if (!configuredM2mClientId || configuredM2mClientId !== clientAuth.clientId) {
    return null;
  }

  return { app, ownerUserId };
}

/** Tolerant JSON body read — malformed / non-object bodies become `{}`. */
export async function readJsonObjectBody(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}
