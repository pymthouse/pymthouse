import { and, eq } from "drizzle-orm";
import { db } from "./db-conn";
import type { DrizzleDb } from "./db-conn";
import { appUsers, developerApps, endUsers, oidcClients } from "@/db/schema";

export type { DrizzleDb } from "./db-conn";

export async function getConfidentialOidcClientByClientId(
  dbConn: DrizzleDb,
  clientId: string,
) {
  const rows = await dbConn
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPublicOidcClientDevicePolicy(
  dbConn: DrizzleDb,
  clientId: string,
) {
  const rows = await dbConn
    .select({
      id: oidcClients.id,
      deviceThirdPartyInitiateLogin: oidcClients.deviceThirdPartyInitiateLogin,
    })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDeveloperAppIdByOidcClientRowId(
  dbConn: DrizzleDb,
  oidcClientRowId: string,
) {
  const rows = await dbConn
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(eq(developerApps.oidcClientId, oidcClientRowId))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function getAppUserExternalUserId(
  dbConn: DrizzleDb,
  appUserId: string,
) {
  const rows = await dbConn
    .select({ externalUserId: appUsers.externalUserId })
    .from(appUsers)
    .where(eq(appUsers.id, appUserId))
    .limit(1);
  return rows[0]?.externalUserId ?? null;
}

export async function getGatewayAppUserExternalUserId(
  dbConn: DrizzleDb,
  developerAppId: string,
  appUserId: string,
) {
  const rows = await dbConn
    .select({ externalUserId: appUsers.externalUserId })
    .from(appUsers)
    .where(and(eq(appUsers.clientId, developerAppId), eq(appUsers.id, appUserId)))
    .limit(1);
  return rows[0]?.externalUserId ?? null;
}

export async function getGatewayEndUserId(
  dbConn: DrizzleDb,
  developerAppId: string,
  endUserId: string,
) {
  const rows = await dbConn
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(and(eq(endUsers.id, endUserId), eq(endUsers.appId, developerAppId)))
    .limit(1);
  return rows[0]?.id ?? null;
}
