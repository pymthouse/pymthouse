import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import {
  appUsers,
  developerApps,
  endUsers,
  oidcClients,
  signerConfig,
} from "@/db/schema";

export async function getDefaultSigner() {
  const rows = await db.select().from(signerConfig).where(eq(signerConfig.id, "default")).limit(1);
  return rows[0] ?? null;
}

export async function resolveDeveloperAppIdFromAuthAppId(
  authAppId: string | null | undefined,
): Promise<string | null> {
  if (!authAppId?.trim()) return null;
  const trimmed = authAppId.trim();

  const rows = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, trimmed))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function resolveUsageUserIdentifier(params: {
  auth: {
    userId: string | null;
    endUserId: string | null;
  };
  providerAppId: string | null;
}): Promise<string | null> {
  const { auth, providerAppId } = params;
  if (!providerAppId) return auth.userId || auth.endUserId || null;

  if (auth.endUserId) {
    const rows = await db
      .select({ externalUserId: endUsers.externalUserId })
      .from(endUsers)
      .where(and(eq(endUsers.id, auth.endUserId), eq(endUsers.appId, providerAppId)))
      .limit(1);
    return rows[0]?.externalUserId || auth.endUserId;
  }

  if (auth.userId) {
    const rows = await db
      .select({ externalUserId: appUsers.externalUserId })
      .from(appUsers)
      .where(and(eq(appUsers.id, auth.userId), eq(appUsers.clientId, providerAppId)))
      .limit(1);
    return rows[0]?.externalUserId || auth.userId;
  }

  return null;
}

export async function readSignerAppApproval(authAppId: string) {
  const trimmed = authAppId.trim();
  const rows = await db
    .select({
      id: developerApps.id,
      status: developerApps.status,
      ownerId: developerApps.ownerId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, trimmed))
    .limit(1);
  return rows[0] ?? null;
}
