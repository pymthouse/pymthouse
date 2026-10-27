import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients, providerAdmins } from "@/db/schema";

export async function getOidcClientIdRowByClientId(clientId: string) {
  const rows = await db
    .select({ id: oidcClients.id })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDeveloperAppAccessByOidcClientRowId(oidcClientRowId: string) {
  const rows = await db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      status: developerApps.status,
      ownerId: developerApps.ownerId,
    })
    .from(developerApps)
    .where(eq(developerApps.oidcClientId, oidcClientRowId))
    .limit(1);
  return rows[0] ?? null;
}

export async function hasProviderAdminAccess(appId: string, userId: string) {
  const rows = await db
    .select({ id: providerAdmins.id })
    .from(providerAdmins)
    .where(and(eq(providerAdmins.clientId, appId), eq(providerAdmins.userId, userId)))
    .limit(1);
  return rows.length > 0;
}
