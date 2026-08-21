/**
 * Owned Builder apps selectable during MCP OAuth consent.
 */

import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

export type OwnedAppChoice = {
  developerAppId: string;
  publicClientId: string;
  name: string;
};

export async function listOwnedAppsForUser(
  ownerUserId: string,
): Promise<OwnedAppChoice[]> {
  const rows = await db
    .select({
      developerAppId: developerApps.id,
      name: developerApps.name,
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.ownerId, ownerUserId));

  return rows.map((row) => ({
    developerAppId: row.developerAppId,
    publicClientId: row.publicClientId,
    name: row.name,
  }));
}

export async function resolveOwnedAppChoice(
  ownerUserId: string,
  publicClientId: string,
): Promise<OwnedAppChoice | null> {
  const trimmed = publicClientId.trim();
  if (!trimmed) return null;
  const apps = await listOwnedAppsForUser(ownerUserId);
  return pickOwnedAppForMcp(apps, trimmed);
}

/** Authorize query `app_client_id` (or `app`) when the caller names an app. */
export function readSpecifiedAppClientId(
  params: Record<string, unknown>,
): string | null {
  const raw = params.app_client_id ?? params.app;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((value) => typeof value === "string" && value.trim());
    return typeof first === "string" ? first.trim() : null;
  }
  return null;
}

/**
 * Bind MCP usage to an owned Builder app.
 * Specified public client id wins; otherwise the owner's only app, or a
 * stable default when they own several.
 */
export function pickOwnedAppForMcp(
  apps: OwnedAppChoice[],
  specifiedPublicClientId?: string | null,
): OwnedAppChoice | null {
  const specified = specifiedPublicClientId?.trim();
  if (specified) {
    return apps.find((app) => app.publicClientId === specified) ?? null;
  }
  if (apps.length === 0) return null;
  if (apps.length === 1) return apps[0];
  return [...apps].sort((a, b) =>
    a.developerAppId.localeCompare(b.developerAppId),
  )[0];
}

export async function resolveMcpAppForOwner(
  ownerUserId: string,
  specifiedPublicClientId?: string | null,
): Promise<OwnedAppChoice | null> {
  const apps = await listOwnedAppsForUser(ownerUserId);
  return pickOwnedAppForMcp(apps, specifiedPublicClientId);
}
