import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { authOptions } from "@/lib/next-auth-options";
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

export async function getProviderApp(appId: string) {
  const byClientId = await getProviderAppByClientId(appId);
  if (byClientId) {
    return byClientId;
  }

  const rows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, appId))
    .limit(1);
  return rows[0] ?? null;
}

export async function isProviderAdmin(userId: string, appId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(providerAdmins)
    .where(
      and(
        eq(providerAdmins.userId, userId),
        eq(providerAdmins.clientId, appId),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export async function ensureProviderAdminMembership(userId: string, appId: string) {
  const membership = {
    id: crypto.randomUUID(),
    userId,
    clientId: appId,
    role: "owner",
    createdAt: new Date().toISOString(),
  } as const;

  await db
    .insert(providerAdmins)
    .values(membership)
    .onConflictDoNothing();

  // Return the existing or newly created row
  const rows = await db
    .select()
    .from(providerAdmins)
    .where(
      and(
        eq(providerAdmins.userId, userId),
        eq(providerAdmins.clientId, appId),
      ),
    )
    .limit(1);
  return rows[0] ?? membership;
}

export async function getAuthorizedProviderApp(appId: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;

  const userId = (session.user as Record<string, unknown>).id as string | undefined;
  const role = (session.user as Record<string, unknown>).role as string | undefined;
  if (!userId) return null;

  const app = await getProviderApp(appId);
  if (!app) return null;

  if (
    role === "admin" ||
    app.ownerId === userId ||
    (await isProviderAdmin(userId, app.id))
  ) {
    return { app, userId, role: role ?? "developer" };
  }

  return null;
}

export type AuthorizedProviderApp = NonNullable<
  Awaited<ReturnType<typeof getAuthorizedProviderApp>>
>;

/**
 * Whether the session user may change app configuration (metadata, OIDC, domains,
 * credentials, plans, signer, team admins, etc.). Platform `users.role === "admin"`,
 * the app owner, and provider team members with role `owner` or `admin` may edit.
 */
export async function canEditProviderApp(
  auth: AuthorizedProviderApp,
): Promise<boolean> {
  if (auth.role === "admin") return true;
  if (auth.app.ownerId === auth.userId) return true;

  const rows = await db
    .select({ role: providerAdmins.role })
    .from(providerAdmins)
    .where(
      and(
        eq(providerAdmins.userId, auth.userId),
        eq(providerAdmins.clientId, auth.app.id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  return row.role === "owner" || row.role === "admin";
}

export function appEditForbiddenResponse() {
  return NextResponse.json(
    {
      error:
        "Only platform or app administrators can modify this app.",
    },
    { status: 403 },
  );
}
