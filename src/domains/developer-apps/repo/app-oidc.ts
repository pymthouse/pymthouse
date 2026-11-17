import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appAllowedDomains, oidcClients } from "@/db/schema";

export async function getOidcClientByRowId(id: string) {
  const rows = await db.select().from(oidcClients).where(eq(oidcClients.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listAppAllowedDomains(appId: string) {
  return db
    .select()
    .from(appAllowedDomains)
    .where(eq(appAllowedDomains.appId, appId));
}
