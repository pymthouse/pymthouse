import type { Adapter, AdapterPayload } from "oidc-provider";
import {
  bindDeviceApprovalIfUnbound as bindDeviceApprovalIfUnboundRepo,
  cleanupExpiredOidcPayloads,
  consumeOidcPayload,
  deleteOidcPayload,
  deleteOidcPayloadsByGrantId,
  getOidcPayloadById,
  getOidcPayloadByUid,
  getOidcPayloadByUserCode,
  upsertOidcPayload,
} from "../repo/oidc-payloads";

const GRANTABLE = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
]);

function rowToPayload(row: { payload: string; consumedAt: number | null } | null): AdapterPayload | undefined {
  if (!row) return undefined;
  const data = JSON.parse(row.payload) as AdapterPayload;
  if (row.consumedAt) data.consumed = row.consumedAt;
  return data;
}

export class PostgresOidcAdapter implements Adapter {
  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    const expiresAt = expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null;
    await upsertOidcPayload({
      id,
      model: this.model,
      payload: JSON.stringify(payload),
      expiresAt,
      uid: payload.uid ?? null,
      userCode: payload.userCode ?? null,
      grantId: payload.grantId ?? null,
    });
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return rowToPayload(await getOidcPayloadById(id, this.model));
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return rowToPayload(await getOidcPayloadByUid(uid, this.model));
  }

  async bindDeviceApprovalIfUnbound(id: string, payload: AdapterPayload, expiresIn: number): Promise<boolean> {
    if (this.model !== "DeviceCode") {
      throw new TypeError("bindDeviceApprovalIfUnbound is only for DeviceCode");
    }
    const expiresAt = expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null;
    const grantIdCol =
      typeof (payload as Record<string, unknown>).grantId === "string"
        ? ((payload as Record<string, unknown>).grantId as string)
        : null;
    return bindDeviceApprovalIfUnboundRepo({
      id,
      model: this.model,
      payload: JSON.stringify(payload),
      expiresAt,
      uid: payload.uid ?? null,
      userCode: payload.userCode ?? null,
      grantId: grantIdCol,
    });
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return rowToPayload(await getOidcPayloadByUserCode(userCode, this.model));
  }

  async consume(id: string): Promise<void> {
    await consumeOidcPayload(id, this.model, Math.floor(Date.now() / 1000));
  }

  async destroy(id: string): Promise<void> {
    await deleteOidcPayload(id, this.model);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    if (GRANTABLE.has(this.model)) {
      await deleteOidcPayloadsByGrantId(grantId, this.model);
    }
  }

  static async cleanup(): Promise<void> {
    await cleanupExpiredOidcPayloads(Math.floor(Date.now() / 1000));
  }
}

export const SqliteAdapter = PostgresOidcAdapter;
