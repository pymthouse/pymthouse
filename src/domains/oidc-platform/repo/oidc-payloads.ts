import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { oidcPayloads } from "@/db/schema";

export async function upsertOidcPayload(params: {
  id: string;
  model: string;
  payload: string;
  expiresAt: number | null;
  uid: string | null;
  userCode: string | null;
  grantId: string | null;
}) {
  await db
    .insert(oidcPayloads)
    .values({
      id: params.id,
      model: params.model,
      payload: params.payload,
      expiresAt: params.expiresAt,
      uid: params.uid,
      userCode: params.userCode,
      grantId: params.grantId,
      consumedAt: null,
    })
    .onConflictDoUpdate({
      target: [oidcPayloads.id, oidcPayloads.model],
      set: {
        payload: params.payload,
        expiresAt: params.expiresAt,
        uid: params.uid,
        userCode: params.userCode,
        grantId: params.grantId,
      },
    });
}

export async function getOidcPayloadById(id: string, model: string) {
  const rows = await db
    .select()
    .from(oidcPayloads)
    .where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.model, model)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOidcPayloadByUid(uid: string, model: string) {
  const rows = await db
    .select()
    .from(oidcPayloads)
    .where(and(eq(oidcPayloads.uid, uid), eq(oidcPayloads.model, model)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOidcPayloadByUserCode(userCode: string, model: string) {
  const rows = await db
    .select()
    .from(oidcPayloads)
    .where(and(eq(oidcPayloads.userCode, userCode), eq(oidcPayloads.model, model)))
    .limit(1);
  return rows[0] ?? null;
}

export async function bindDeviceApprovalIfUnbound(params: {
  id: string;
  model: string;
  payload: string;
  expiresAt: number | null;
  uid: string | null;
  userCode: string | null;
  grantId: string | null;
}) {
  const updated = await db
    .update(oidcPayloads)
    .set({
      payload: params.payload,
      expiresAt: params.expiresAt,
      uid: params.uid,
      userCode: params.userCode,
      grantId: params.grantId,
    })
    .where(
      and(
        eq(oidcPayloads.id, params.id),
        eq(oidcPayloads.model, params.model),
        isNull(oidcPayloads.grantId),
        sql`coalesce((${oidcPayloads.payload})::jsonb->>'accountId', '') = ''`,
        sql`coalesce((${oidcPayloads.payload})::jsonb->>'grantId', '') = ''`,
      ),
    )
    .returning({ id: oidcPayloads.id });

  return updated.length > 0;
}

export async function consumeOidcPayload(id: string, model: string, consumedAt: number) {
  await db
    .update(oidcPayloads)
    .set({ consumedAt })
    .where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.model, model)));
}

export async function deleteOidcPayload(id: string, model: string) {
  await db
    .delete(oidcPayloads)
    .where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.model, model)));
}

export async function deleteOidcPayloadsByGrantId(grantId: string, model: string) {
  await db
    .delete(oidcPayloads)
    .where(and(eq(oidcPayloads.grantId, grantId), eq(oidcPayloads.model, model)));
}

export async function cleanupExpiredOidcPayloads(now: number) {
  await db
    .delete(oidcPayloads)
    .where(and(isNotNull(oidcPayloads.expiresAt), lt(oidcPayloads.expiresAt, now)));
}
