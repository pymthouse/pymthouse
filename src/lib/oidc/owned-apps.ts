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
  return apps.find((a) => a.publicClientId === trimmed) ?? null;
}
