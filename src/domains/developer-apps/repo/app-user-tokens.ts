import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appUsers, oidcClients } from "@/db/schema";

export async function getPublicAllowedScopesForClient(clientId: string) {
  const rows = await db
    .select({ allowedScopes: oidcClients.allowedScopes })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0]?.allowedScopes ?? "";
}

export async function getActiveAppUserByExternalUserId(appId: string, externalUserId: string) {
  const rows = await db
    .select()
    .from(appUsers)
    .where(and(eq(appUsers.clientId, appId), eq(appUsers.externalUserId, externalUserId)))
    .limit(1);
  const appUser = rows[0];
  if (!appUser || appUser.status !== "active") return null;
  return appUser;
}
