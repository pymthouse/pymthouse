import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

export async function getOidcClientByClientId(clientId: string) {
  const rows = await db.select().from(oidcClients).where(eq(oidcClients.clientId, clientId)).limit(1);
  return rows[0] ?? null;
}

export async function getDeveloperAppByOidcClientRowId(oidcClientRowId: string) {
  const rows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.oidcClientId, oidcClientRowId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDeveloperAppByAppId(appId: string) {
  const rows = await db.select().from(developerApps).where(eq(developerApps.id, appId)).limit(1);
  return rows[0] ?? null;
}

export async function getDeveloperAppByCustomDomain(domain: string) {
  const rows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.customLoginDomain, domain))
    .limit(1);
  return rows[0] ?? null;
}
