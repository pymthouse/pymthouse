import { db } from "@/db/index";
import {
  appUsers,
  developerApps,
  oidcClients,
  providerAdmins,
  transactions,
  users,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

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

/** Live apps first, then in-review, then drafts, with rejected last. */
const STATUS_PRIORITY: Record<string, number> = {
  approved: 0,
  in_review: 1,
  submitted: 1,
  draft: 2,
  rejected: 3,
};

function statusPriority(status: string): number {
  return STATUS_PRIORITY[status] ?? 2;
}

type AppActivityCounts = { usageCount: number; userCount: number };

async function getAppActivityCounts(appIds: string[]): Promise<Map<string, AppActivityCounts>> {
  if (appIds.length === 0) return new Map();

  const [usageRows, userRows] = await Promise.all([
    db
      .select({ clientId: transactions.clientId, count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(
          inArray(transactions.clientId, appIds),
          eq(transactions.type, "usage"),
          eq(transactions.status, "confirmed"),
        ),
      )
      .groupBy(transactions.clientId),
    db
      .select({ clientId: appUsers.clientId, count: sql<number>`count(*)::int` })
      .from(appUsers)
      .where(inArray(appUsers.clientId, appIds))
      .groupBy(appUsers.clientId),
  ]);

  const activity = new Map<string, AppActivityCounts>();
  for (const row of usageRows) {
    if (!row.clientId) continue;
    activity.set(row.clientId, { usageCount: row.count, userCount: 0 });
  }
  for (const row of userRows) {
    const existing = activity.get(row.clientId) ?? { usageCount: 0, userCount: 0 };
    activity.set(row.clientId, { ...existing, userCount: row.count });
  }
  return activity;
}

/**
 * Canonical ordering for every app listing in the product: status priority
 * (live apps first, then in-review/submitted, drafts, rejected last), then a
 * combined usage + user-count activity factor (most active apps first
 * within the same status tier), and finally creation date (newest first) as
 * a stable tie-breaker. Not user-configurable — purely internal ranking.
 */
export async function sortAppsByPriority<
  T extends { id: string; status: string; createdAt: string },
>(apps: T[]): Promise<T[]> {
  const activity = await getAppActivityCounts(apps.map((app) => app.id));
  return [...apps].sort((a, b) => {
    const statusDiff = statusPriority(a.status) - statusPriority(b.status);
    if (statusDiff !== 0) return statusDiff;

    const activityA = activity.get(a.id);
    const activityB = activity.get(b.id);
    const scoreA = (activityA?.usageCount ?? 0) + (activityA?.userCount ?? 0);
    const scoreB = (activityB?.usageCount ?? 0) + (activityB?.userCount ?? 0);
    if (scoreA !== scoreB) return scoreB - scoreA;

    return b.createdAt.localeCompare(a.createdAt);
  });
}

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

  const merged = [...ownedApps, ...memberApps]
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
    .filter((app) => app.id.length > 0);

  return sortAppsByPriority(merged);
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

  const apps = rows
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
    }));

  return sortAppsByPriority(apps);
}
