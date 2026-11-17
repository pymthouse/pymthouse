import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appUsers } from "@/db/schema";

export async function listAppUsers(appId: string) {
  return db.select().from(appUsers).where(eq(appUsers.clientId, appId));
}

export async function upsertAppUser(params: {
  appId: string;
  externalUserId: string;
  email: string | null;
  status: string;
  hasEmail: boolean;
  hasStatus: boolean;
  createdAt: string;
}) {
  const newUser = {
    id: crypto.randomUUID(),
    clientId: params.appId,
    externalUserId: params.externalUserId,
    email: params.email,
    status: params.status,
    role: "user" as const,
    createdAt: params.createdAt,
  };

  const updateSet: { email?: string | null; status?: string; role: "user" } = {
    role: "user",
  };
  if (params.hasEmail) updateSet.email = params.email;
  if (params.hasStatus) updateSet.status = params.status;

  const upserted = await db
    .insert(appUsers)
    .values(newUser)
    .onConflictDoUpdate({
      target: [appUsers.clientId, appUsers.externalUserId],
      set: updateSet,
    })
    .returning();

  return {
    row: upserted[0] ?? newUser,
    created: (upserted[0] ?? newUser).id === newUser.id,
  };
}

export async function getAppUserByExternalUserId(appId: string, externalUserId: string) {
  const rows = await db
    .select()
    .from(appUsers)
    .where(
      and(eq(appUsers.clientId, appId), eq(appUsers.externalUserId, externalUserId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function updateAppUserById(
  id: string,
  updates: { email: string | null; status: string; role: "user" },
) {
  await db.update(appUsers).set(updates).where(eq(appUsers.id, id));
}

export async function deactivateAppUser(id: string) {
  await db.update(appUsers).set({ status: "inactive" }).where(eq(appUsers.id, id));
}
