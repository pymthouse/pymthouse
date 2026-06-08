import { PmtHouseError } from "@pymthouse/builder-sdk";
import { db } from "@/db/index";
import { appUsers, developerApps, endUsers, oidcClients } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { AuthResult } from "@/lib/auth";
import { authenticateRequestAsync, hasScope } from "@/lib/auth";
import { resolveDeveloperAppIdFromAuthAppId } from "@/lib/signer-proxy";

export type SignerSession = AuthResult;

export async function authenticateSignerSession(
  request: Request,
): Promise<SignerSession | null> {
  const auth = await authenticateRequestAsync(request as never);
  if (!auth || !hasScope(auth.scopes, "sign:job")) {
    return null;
  }

  if (auth.appId) {
    const trimmed = auth.appId.trim();
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
    const app = rows[0] ?? null;
    if (app && app.status !== "approved" && auth.userId !== app.ownerId) {
      throw new PmtHouseError("App is not approved for signing", {
        status: 403,
        code: "app_not_approved",
      });
    }
  }

  return auth;
}

export async function resolveSignerPublicClientId(
  session: SignerSession,
): Promise<string> {
  const clientId = session.appId?.trim();
  if (!clientId) {
    throw new Error("missing app client id on signer session");
  }
  return clientId;
}

export async function resolveSignerExternalUserId(
  session: SignerSession,
): Promise<string> {
  const providerAppId = await resolveDeveloperAppIdFromAuthAppId(session.appId);
  const externalUserId = await resolveUsageUserIdentifier(session, providerAppId);
  if (!externalUserId?.trim()) {
    throw new Error("missing external user id for signer session");
  }
  return externalUserId.trim();
}

async function resolveUsageUserIdentifier(
  auth: AuthResult,
  providerAppId: string | null,
): Promise<string | null> {
  if (!providerAppId) {
    return auth.userId || auth.endUserId || null;
  }

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
