import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db/index";
import { sessions } from "@/db/schema";

export async function createStoredSession(params: {
  id: string;
  userId?: string;
  endUserId?: string;
  appId?: string;
  label?: string;
  tokenHash: string;
  scopes: string;
  expiresAt: string;
}) {
  await db.insert(sessions).values({
    id: params.id,
    userId: params.userId || null,
    endUserId: params.endUserId || null,
    appId: params.appId || null,
    label: params.label || null,
    tokenHash: params.tokenHash,
    scopes: params.scopes,
    expiresAt: params.expiresAt,
  });
}

export async function deleteSessionById(sessionId: string) {
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.id, sessionId))
    .returning({ id: sessions.id });
  return deleted.length > 0;
}

export async function consumeSessionByIdHashAndExpiry(params: {
  sessionId: string;
  tokenHash: string;
  now: string;
}) {
  const rows = await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.id, params.sessionId),
        eq(sessions.tokenHash, params.tokenHash),
        gt(sessions.expiresAt, params.now),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function getActiveSessionByTokenHash(tokenHash: string, now: string) {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listSessionsForAdminView() {
  return db
    .select({
      id: sessions.id,
      label: sessions.label,
      endUserId: sessions.endUserId,
      scopes: sessions.scopes,
      expiresAt: sessions.expiresAt,
      createdAt: sessions.createdAt,
    })
    .from(sessions);
}
