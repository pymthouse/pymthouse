import { db } from "@/db/index";
import { developerApps, oidcClients, providerAdmins, users } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

export type UserAppSummary = {
  id: string;
  name: string;
  subtitle: string | null;
  category: string | null;
  status: string;
  logoLightUrl: string | null;
  clientId: string | null;
  createdAt: string;
  isOwner: boolean;
  ownerExternalUserId: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
};

/** Apps the user owns or is an admin of (same set as GET /api/v1/apps). */
export async function listUserAccessibleApps(userId: string): Promise<UserAppSummary[]> {
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
      createdAt: developerApps.createdAt,
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
            createdAt: developerApps.createdAt,
            clientId: oidcClients.clientId,
          })
          .from(developerApps)
          .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
          .where(inArray(developerApps.id, memberIds));

  const ownedIds = new Set(ownedApps.map((a) => a.id).filter(Boolean));

  return [...ownedApps, ...memberApps]
    .filter(
      (app, index, rows) => rows.findIndex((row) => row.id === app.id) === index,
    )
    .map((app) => ({
      id: app.id ?? "",
      name: app.name,
      subtitle: app.subtitle,
      category: app.category,
      status: app.status,
      logoLightUrl: app.logoLightUrl,
      clientId: app.clientId,
      createdAt: app.createdAt,
      isOwner: ownedIds.has(app.id ?? ""),
      ownerExternalUserId: ownedIds.has(app.id ?? "") ? userId : null,
    }))
    .filter((app) => app.id.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every app registered on the platform, regardless of ownership. Intended for the
 * admin "All apps" toggle — admins can already reach these apps individually, this
 * just surfaces them in one list. Not shown by default.
 */
export async function listAllAppsForAdmin(userId: string): Promise<UserAppSummary[]> {
  const rows = await db
    .select({
      id: oidcClients.clientId,
      name: developerApps.name,
      subtitle: developerApps.subtitle,
      category: developerApps.category,
      status: developerApps.status,
      logoLightUrl: developerApps.logoLightUrl,
      createdAt: developerApps.createdAt,
      clientId: oidcClients.clientId,
      ownerId: developerApps.ownerId,
      ownerName: users.name,
      ownerEmail: users.email,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(users, eq(developerApps.ownerId, users.id));

  return rows
    .filter((app) => (app.id ?? "").length > 0)
    .map((app) => ({
      id: app.id ?? "",
      name: app.name,
      subtitle: app.subtitle,
      category: app.category,
      status: app.status,
      logoLightUrl: app.logoLightUrl,
      clientId: app.clientId,
      createdAt: app.createdAt,
      isOwner: app.ownerId === userId,
      ownerExternalUserId: app.ownerId === userId ? userId : null,
      ownerName: app.ownerName,
      ownerEmail: app.ownerEmail,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
