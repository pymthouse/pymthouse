import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

export async function getOidcClientByClientId(clientId: string) {
  const rows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getApprovedAppByOidcClientRowId(oidcClientRowId: string) {
  const rows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.oidcClientId, oidcClientRowId))
    .limit(1);
  const app = rows[0] ?? null;
  if (!app || app.status !== "approved") return null;
  return app;
}
