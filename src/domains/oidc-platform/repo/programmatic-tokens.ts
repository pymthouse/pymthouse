import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appUsers, developerApps, oidcClients } from "@/db/schema";

export async function getProgrammaticTokenAppPolicy(developerAppId: string) {
  const rows = await db
    .select({ allowedScopes: oidcClients.allowedScopes })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.id, developerAppId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getProgrammaticTokenBinding(input: {
  developerAppId: string;
  oauthClientId: string;
  appUserId: string;
}) {
  const rows = await db
    .select({
      oauthClientId: oidcClients.clientId,
      appUserId: appUsers.id,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .innerJoin(
      appUsers,
      and(eq(appUsers.clientId, developerApps.id), eq(appUsers.id, input.appUserId)),
    )
    .where(
      and(
        eq(developerApps.id, input.developerAppId),
        eq(oidcClients.clientId, input.oauthClientId),
        eq(appUsers.status, "active"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getRefreshTokenProgrammaticApp(sessionAppId: string) {
  const rows = await db
    .select({
      appId: developerApps.id,
      oauthClientId: oidcClients.clientId,
      allowedScopes: oidcClients.allowedScopes,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, sessionAppId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getActiveAppUserForRefresh(appUserId: string, appId: string) {
  const rows = await db
    .select()
    .from(appUsers)
    .where(and(eq(appUsers.id, appUserId), eq(appUsers.clientId, appId)))
    .limit(1);
  return rows[0] ?? null;
}
