import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";

export async function updateDeveloperApp(appId: string, updates: Record<string, unknown>) {
  await db.update(developerApps).set(updates).where(eq(developerApps.id, appId));
}

export async function getOidcClientByRowId(id: string) {
  const rows = await db.select().from(oidcClients).where(eq(oidcClients.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getM2mClientSummaryForApp(appId: string) {
  const refreshed = await db
    .select({ m2mOidcClientId: developerApps.m2mOidcClientId })
    .from(developerApps)
    .where(eq(developerApps.id, appId))
    .limit(1);
  const m2mPk = refreshed[0]?.m2mOidcClientId;
  if (!m2mPk) return null;

  const rows = await db.select().from(oidcClients).where(eq(oidcClients.id, m2mPk)).limit(1);
  const client = rows[0];
  if (!client) return null;

  return {
    clientId: client.clientId,
    hasSecret: !!client.clientSecretHash,
  };
}

export async function transitionAppStatus(params: {
  appId: string;
  allowedCurrentStatuses: string[];
  nextStatus: string;
  submittedAt: string | null;
  updatedAt: string;
}) {
  return db
    .update(developerApps)
    .set({
      status: params.nextStatus,
      submittedAt: params.submittedAt,
      updatedAt: params.updatedAt,
    })
    .where(
      and(
        eq(developerApps.id, params.appId),
        inArray(developerApps.status, params.allowedCurrentStatuses),
      ),
    )
    .returning({ id: developerApps.id });
}
