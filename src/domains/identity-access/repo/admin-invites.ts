import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db/index";
import { adminInvites, users } from "@/db/schema";

export async function createAdminInvite(params: {
  id: string;
  code: string;
  createdBy: string;
  expiresAt: string;
}) {
  await db.insert(adminInvites).values(params);
}

export async function listOpenAdminInvites(now: string) {
  return db
    .select()
    .from(adminInvites)
    .where(and(isNull(adminInvites.usedBy), gt(adminInvites.expiresAt, now)));
}

export async function claimAdminInviteAndPromoteUser(params: {
  code: string;
  userId: string;
  now: string;
}) {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(adminInvites)
      .set({ usedBy: params.userId })
      .where(
        and(
          eq(adminInvites.code, params.code),
          isNull(adminInvites.usedBy),
          gt(adminInvites.expiresAt, params.now),
        ),
      )
      .returning({ id: adminInvites.id });

    if (claimed.length === 0) {
      return { ok: false as const };
    }

    await tx.update(users).set({ role: "admin" }).where(eq(users.id, params.userId));
    return { ok: true as const };
  });
}
