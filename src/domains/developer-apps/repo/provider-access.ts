import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients, providerAdmins } from "@/db/schema";

export async function getProviderAppByClientId(clientId: string) {
  const byPublic = await db
    .select({ app: developerApps })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  if (byPublic[0]?.app) {
    return byPublic[0].app;
  }

  const byM2m = await db
    .select({ app: developerApps })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.m2mOidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  return byM2m[0]?.app ?? null;
}

export async function getProviderApp(appIdOrClientId: string) {
  const byClientId = await getProviderAppByClientId(appIdOrClientId);
  if (byClientId) {
    return byClientId;
  }

  const rows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appIdOrClientId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getProviderAdminMembership(userId: string, appId: string) {
  const rows = await db
    .select()
    .from(providerAdmins)
    .where(and(eq(providerAdmins.userId, userId), eq(providerAdmins.clientId, appId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function isProviderAdmin(userId: string, appId: string): Promise<boolean> {
  return (await getProviderAdminMembership(userId, appId)) !== null;
}

export async function ensureProviderAdminMembership(userId: string, appId: string) {
  const membership = {
    id: crypto.randomUUID(),
    userId,
    clientId: appId,
    role: "owner",
    createdAt: new Date().toISOString(),
  } as const;

  await db.insert(providerAdmins).values(membership).onConflictDoNothing();
  return (await getProviderAdminMembership(userId, appId)) ?? membership;
}

export async function listAppsVisibleToUser(userId: string) {
  const memberships = await db
    .select({ clientId: providerAdmins.clientId })
    .from(providerAdmins)
    .where(eq(providerAdmins.userId, userId));

  const memberIds = memberships.map((membership) => membership.clientId);
  const ownedApps = await db
    .select({
      id: oidcClients.clientId,
      name: developerApps.name,
      subtitle: developerApps.subtitle,
      category: developerApps.category,
      status: developerApps.status,
      logoLightUrl: developerApps.logoLightUrl,
      brandingMode: developerApps.brandingMode,
      customLoginEnabled: developerApps.customLoginEnabled,
      customLoginDomain: developerApps.customLoginDomain,
      createdAt: developerApps.createdAt,
      updatedAt: developerApps.updatedAt,
      clientId: oidcClients.clientId,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.ownerId, userId));

  const memberApps =
    memberIds.length === 0
      ? []
      : await db
          .select({
            id: oidcClients.clientId,
            name: developerApps.name,
            subtitle: developerApps.subtitle,
            category: developerApps.category,
            status: developerApps.status,
            logoLightUrl: developerApps.logoLightUrl,
            brandingMode: developerApps.brandingMode,
            customLoginEnabled: developerApps.customLoginEnabled,
            customLoginDomain: developerApps.customLoginDomain,
            createdAt: developerApps.createdAt,
            updatedAt: developerApps.updatedAt,
            clientId: oidcClients.clientId,
          })
          .from(developerApps)
          .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
          .where(inArray(developerApps.id, memberIds));

  return [...ownedApps, ...memberApps].filter(
    (app, index, rows) => rows.findIndex((row) => row.id === app.id) === index,
  );
}
