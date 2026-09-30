import { and, eq, or } from "drizzle-orm";

import { db } from "@/db/index";
import {
  appUsers,
  developerApps,
  oidcClients,
  providerAdmins,
  users,
} from "@/db/schema";
import { resolvePlatformDefaultClientId } from "@/lib/platform-default-app";

/**
 * Usage-history visibility for one platform user, split by how much of an app
 * they may read.
 */
export type ViewerUsageClientScopes = {
  /**
   * Apps the viewer owns or administers. Every identity's request history on
   * these apps is readable (same authorization as the app identity pages).
   */
  managed: string[];
  /**
   * Apps where the viewer only holds an `app_users` membership. Restricted to
   * the viewer's own usage subjects.
   */
  member: string[];
};

/**
 * Public OIDC client_ids the signed-in platform user may include in
 * `scope=own` usage history, split into managed (own/administer) and
 * membership-only apps (including the platform default).
 */
export async function resolveViewerUsageClientScopes(
  userId: string,
): Promise<ViewerUsageClientScopes> {
  const trimmed = userId.trim();
  if (!trimmed) return { managed: [], member: [] };

  const [ownedRows, adminRows, memberRows] = await Promise.all([
    db
      .select({ publicClientId: oidcClients.clientId, appId: developerApps.id })
      .from(developerApps)
      .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
      .where(eq(developerApps.ownerId, trimmed)),
    db
      .select({
        publicClientId: oidcClients.clientId,
        appId: developerApps.id,
      })
      .from(providerAdmins)
      .innerJoin(developerApps, eq(providerAdmins.clientId, developerApps.id))
      .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
      .where(eq(providerAdmins.userId, trimmed)),
    db
      .select({
        publicClientId: oidcClients.clientId,
        appId: developerApps.id,
      })
      .from(appUsers)
      .innerJoin(developerApps, eq(appUsers.clientId, developerApps.id))
      .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
      .where(and(eq(appUsers.externalUserId, trimmed), eq(appUsers.status, "active"))),
  ]);

  const managed = new Set<string>();
  for (const row of [...ownedRows, ...adminRows]) {
    const id = row.publicClientId?.trim() || row.appId?.trim();
    if (id) managed.add(id);
  }
  const member = new Set<string>();
  for (const row of memberRows) {
    const id = row.publicClientId?.trim() || row.appId?.trim();
    if (id && !managed.has(id)) member.add(id);
  }
  return { managed: [...managed], member: [...member] };
}

/** Every client_id the viewer may read usage for, managed and membership-only. */
export async function resolveViewerUsageClientIds(
  userId: string,
): Promise<string[]> {
  const scopes = await resolveViewerUsageClientScopes(userId);
  return [...scopes.managed, ...scopes.member];
}

/** True when the viewer has an app_users row on the given public client_id / app id. */
export async function viewerHasAppUserMembership(
  userId: string,
  appOrClientId: string,
): Promise<boolean> {
  const trimmedUser = userId.trim();
  const trimmedApp = appOrClientId.trim();
  if (!trimmedUser || !trimmedApp) return false;

  const rows = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .innerJoin(developerApps, eq(appUsers.clientId, developerApps.id))
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(
      and(
        eq(appUsers.externalUserId, trimmedUser),
        eq(appUsers.status, "active"),
        or(eq(oidcClients.clientId, trimmedApp), eq(developerApps.id, trimmedApp)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Load the canonical platform-default app as a billing row, or null when none.
 */
export async function loadPlatformDefaultBillingApp(): Promise<{
  id: string;
  name: string;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  publicClientId: string;
} | null> {
  const clientId = await resolvePlatformDefaultClientId();
  if (!clientId) return null;

  const rows = await db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      ownerId: developerApps.ownerId,
      ownerName: users.name,
      ownerEmail: users.email,
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .leftJoin(users, eq(developerApps.ownerId, users.id))
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(
      or(eq(oidcClients.clientId, clientId), eq(developerApps.id, clientId)),
    )
    .limit(1);

  const row = rows[0];
  if (!row?.ownerId) return null;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail,
    publicClientId: row.publicClientId?.trim() || row.id,
  };
}
