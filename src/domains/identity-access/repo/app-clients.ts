import { eq, or } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

export async function getOidcClientRowByClientId(clientId: string) {
  const rows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDeveloperAppForOidcClientRow(oidcRowId: string) {
  const rows = await db
    .select()
    .from(developerApps)
    .where(
      or(
        eq(developerApps.oidcClientId, oidcRowId),
        eq(developerApps.m2mOidcClientId, oidcRowId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getOidcClientIdByRowId(oidcRowId: string) {
  const rows = await db
    .select({ clientId: oidcClients.clientId })
    .from(oidcClients)
    .where(eq(oidcClients.id, oidcRowId))
    .limit(1);
  return rows[0]?.clientId ?? null;
}
