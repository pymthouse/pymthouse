import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "./db-conn";
import { developerApps, oidcClients } from "@/db/schema";

export async function getOidcClientByClientId(clientId: string) {
  const rows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateOidcClientByClientId(
  clientId: string,
  updates: Partial<typeof oidcClients.$inferInsert>,
) {
  await db.update(oidcClients).set(updates).where(eq(oidcClients.clientId, clientId));
}

export async function insertOidcClient(values: typeof oidcClients.$inferInsert) {
  await db.insert(oidcClients).values(values);
}

export async function listOidcClients() {
  return db.select().from(oidcClients);
}

export async function getOidcClientDeviceInitiateLogin(clientId: string) {
  const rows = await db
    .select({
      initiateLoginUri: oidcClients.initiateLoginUri,
      deviceThirdPartyInitiateLogin: oidcClients.deviceThirdPartyInitiateLogin,
    })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

export async function createBasicOidcClient(params: {
  clientId: string;
  displayName: string;
  clientSecretHash: string | null;
  redirectUrisJson: string;
  allowedScopes: string;
  grantTypes: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
}) {
  const id = uuidv4();
  await insertOidcClient({
    id,
    clientId: params.clientId,
    clientSecretHash: params.clientSecretHash,
    displayName: params.displayName,
    redirectUris: params.redirectUrisJson,
    allowedScopes: params.allowedScopes,
    grantTypes: params.grantTypes,
    tokenEndpointAuthMethod: params.tokenEndpointAuthMethod,
  });
  return { id, clientId: params.clientId };
}

export async function getDeveloperAppById(appInternalId: string) {
  const rows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appInternalId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOidcClientById(id: string) {
  const rows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateDeveloperAppM2mOidcClientId(appInternalId: string, m2mOidcClientId: string) {
  await db
    .update(developerApps)
    .set({ m2mOidcClientId })
    .where(eq(developerApps.id, appInternalId));
}
