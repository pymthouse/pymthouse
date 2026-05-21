/**
 * PostgreSQL adapter for node-oidc-provider.
 *
 * Stores provider models (Grant, Session, AccessToken, etc.) in `oidc_payloads`
 * as JSON blobs with secondary lookup columns for uid, userCode, and grantId.
 */

import type { Adapter, AdapterPayload } from "oidc-provider";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { oidcPayloads } from "@/db/schema";

const GRANTABLE = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
]);

function rowToPayload(row: {
  payload: string;
  consumedAt: number | null;
} | undefined): AdapterPayload | undefined {
  if (!row) return undefined;
  const data = JSON.parse(row.payload) as AdapterPayload;
  if (row.consumedAt) {
    data.consumed = row.consumedAt;
  }
  return data;
}

export class PostgresOidcAdapter implements Adapter {
  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    const expiresAt = expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null;
    const payloadJson = JSON.stringify(payload);

    await db
      .insert(oidcPayloads)
      .values({
        id,
        model: this.model,
        payload: payloadJson,
        expiresAt,
        uid: payload.uid ?? null,
        userCode: payload.userCode ?? null,
        grantId: payload.grantId ?? null,
        consumedAt: null,
      })
      .onConflictDoUpdate({
        target: [oidcPayloads.id, oidcPayloads.model],
        set: {
          payload: payloadJson,
          expiresAt,
          uid: payload.uid ?? null,
          userCode: payload.userCode ?? null,
          grantId: payload.grantId ?? null,
        },
      });
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const rows = await db
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.model, this.model)))
      .limit(1);
    const row = rows[0];
    return rowToPayload(
      row
        ? { payload: row.payload, consumedAt: row.consumedAt }
        : undefined,
    );
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const rows = await db
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.uid, uid), eq(oidcPayloads.model, this.model)))
      .limit(1);
    const row = rows[0];
    return rowToPayload(
      row
        ? { payload: row.payload, consumedAt: row.consumedAt }
        : undefined,
    );
  }

  /**
   * Binds approval fields on a DeviceCode row only when it is still unbound.
   * Prevents concurrent approvals from overwriting an existing binding.
   */
  async bindDeviceApprovalIfUnbound(
    id: string,
    payload: AdapterPayload,
    expiresIn: number,
  ): Promise<boolean> {
    if (this.model !== "DeviceCode") {
      throw new TypeError("bindDeviceApprovalIfUnbound is only for DeviceCode");
    }
    const expiresAt = expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null;
    const payloadJson = JSON.stringify(payload);
    const grantIdCol =
      typeof (payload as Record<string, unknown>).grantId === "string"
        ? ((payload as Record<string, unknown>).grantId as string)
        : null;

    const updated = await db
      .update(oidcPayloads)
      .set({
        payload: payloadJson,
        expiresAt,
        uid: payload.uid ?? null,
        userCode: payload.userCode ?? null,
        grantId: grantIdCol,
      })
      .where(
        and(
          eq(oidcPayloads.id, id),
          eq(oidcPayloads.model, this.model),
          isNull(oidcPayloads.grantId),
          sql`coalesce((${oidcPayloads.payload})::jsonb->>'accountId', '') = ''`,
          sql`coalesce((${oidcPayloads.payload})::jsonb->>'grantId', '') = ''`,
        ),
      )
      .returning({ id: oidcPayloads.id });

    return updated.length > 0;
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const rows = await db
      .select()
      .from(oidcPayloads)
      .where(
        and(
          eq(oidcPayloads.userCode, userCode),
          eq(oidcPayloads.model, this.model),
        ),
      )
      .limit(1);
    const row = rows[0];
    return rowToPayload(
      row
        ? { payload: row.payload, consumedAt: row.consumedAt }
        : undefined,
    );
  }

  async consume(id: string): Promise<void> {
    await db
      .update(oidcPayloads)
      .set({ consumedAt: Math.floor(Date.now() / 1000) })
      .where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.model, this.model)));
  }

  async destroy(id: string): Promise<void> {
    await db
      .delete(oidcPayloads)
      .where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.model, this.model)));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    if (GRANTABLE.has(this.model)) {
      await db
        .delete(oidcPayloads)
        .where(
          and(
            eq(oidcPayloads.grantId, grantId),
            eq(oidcPayloads.model, this.model),
          ),
        );
    }
  }

  static async cleanup(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await db
      .delete(oidcPayloads)
      .where(
        and(isNotNull(oidcPayloads.expiresAt), lt(oidcPayloads.expiresAt, now)),
      );
  }
}

/** @deprecated Use PostgresOidcAdapter */
export const SqliteAdapter = PostgresOidcAdapter;
