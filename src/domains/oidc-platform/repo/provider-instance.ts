import { desc, eq, or } from "drizzle-orm";
import { db } from "./db-conn";
import { appAllowedDomains, developerApps, oidcClients, oidcSigningKeys } from "@/db/schema";

export async function listRecentSigningKeys(limit = 5) {
  return db
    .select()
    .from(oidcSigningKeys)
    .orderBy(desc(oidcSigningKeys.createdAt))
    .limit(limit);
}

export async function listAllOidcClients() {
  return db.select().from(oidcClients);
}

export async function listDeveloperAppsForOidcClientRowId(oidcClientRowId: string) {
  return db
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(or(eq(developerApps.oidcClientId, oidcClientRowId), eq(developerApps.m2mOidcClientId, oidcClientRowId)))
    .limit(1);
}

export async function listAllowedDomainsForApp(appId: string) {
  return db
    .select({ domain: appAllowedDomains.domain })
    .from(appAllowedDomains)
    .where(eq(appAllowedDomains.appId, appId));
}
