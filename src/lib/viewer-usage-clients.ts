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
 * Public OIDC client_ids the signed-in platform user may include in
 * `scope=own` usage history: apps they own or administer, plus any app where
 * they have an `app_users` membership (including the platform default).
 */
export async function resolveViewerUsageClientIds(
  userId: string,
): Promise<string[]> {
  const trimmed = userId.trim();
  if (!trimmed) return [];

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

  const ids = new Set<string>();
  for (const row of [...ownedRows, ...adminRows, ...memberRows]) {
    const id = row.publicClientId?.trim() || row.appId?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
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
