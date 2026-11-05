import { and, eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { providerAdmins, users } from "@/db/schema";

export async function listAppAdminMemberships(appId: string) {
  const memberships = await db
    .select()
    .from(providerAdmins)
    .where(eq(providerAdmins.clientId, appId));

  const userIds = memberships.map((m) => m.userId);
  const adminUsers = userIds.length > 0 ? await db.select().from(users).where(inArray(users.id, userIds)) : [];

  return { memberships, adminUsers };
}

export async function getUserById(userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getAppAdminMembership(appId: string, userId: string) {
  const rows = await db
    .select()
    .from(providerAdmins)
    .where(and(eq(providerAdmins.clientId, appId), eq(providerAdmins.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createAppAdminMembership(appId: string, userId: string, role: string) {
  const membership = {
    id: uuidv4(),
    userId,
    clientId: appId,
    role,
    createdAt: new Date().toISOString(),
  };

  await db.insert(providerAdmins).values(membership);
  return membership;
}

export async function deleteAppAdminMembership(appId: string, userId: string) {
  await db
    .delete(providerAdmins)
    .where(and(eq(providerAdmins.clientId, appId), eq(providerAdmins.userId, userId)));
}
