import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { x402PaymentCodes } from "@/db/schema";
import type { X402PaymentPayload, X402PaymentRequirements } from "@/lib/x402/schemas";
import {
  x402PaymentPayloadSchema,
  x402PaymentRequirementsSchema,
} from "@/lib/x402/schemas";

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomUserCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
    if (i === 3) {
      out += "-";
    }
  }
  return out;
}

function randomDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

export async function createPaymentCode(input: {
  clientId: string;
  paymentRequirements: X402PaymentRequirements;
  externalUserId?: string | null;
  ttlSeconds?: number;
}): Promise<{
  id: string;
  userCode: string;
  deviceCode: string;
  expiresAt: string;
  verificationUri: string;
  verificationUriComplete: string;
}> {
  const parsed = x402PaymentRequirementsSchema.parse(input.paymentRequirements);
  const ttl = Math.max(60, Math.min(input.ttlSeconds ?? 600, 3600));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  const id = randomUUID();
  const userCode = randomUserCode();
  const deviceCode = randomDeviceCode();
  const base =
    process.env.NEXTAUTH_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "http://localhost:3001";
  const verificationUri = `${base}/x402/approve`;
  const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;

  await db.insert(x402PaymentCodes).values({
    id,
    clientId: input.clientId,
    userCode,
    deviceCode,
    status: "pending",
    paymentRequirements: JSON.stringify(parsed),
    externalUserId: input.externalUserId ?? null,
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  return {
    id,
    userCode,
    deviceCode,
    expiresAt,
    verificationUri,
    verificationUriComplete,
  };
}

export async function getPaymentCodeByUserCode(userCode: string) {
  const normalized = userCode.trim().toUpperCase();
  const rows = await db
    .select()
    .from(x402PaymentCodes)
    .where(eq(x402PaymentCodes.userCode, normalized))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPaymentCodeByDeviceCode(deviceCode: string) {
  const rows = await db
    .select()
    .from(x402PaymentCodes)
    .where(eq(x402PaymentCodes.deviceCode, deviceCode.trim()))
    .limit(1);
  return rows[0] ?? null;
}

export async function getActivePaymentCode(code: string) {
  const byDevice = await getPaymentCodeByDeviceCode(code);
  if (byDevice) {
    return byDevice;
  }
  return getPaymentCodeByUserCode(code);
}

export function isPaymentCodeExpired(row: {
  expiresAt: string;
  status: string;
}): boolean {
  if (row.status === "expired") {
    return true;
  }
  return new Date(row.expiresAt).getTime() <= Date.now();
}

export async function approvePaymentCode(input: {
  userCode: string;
  paymentPayload: X402PaymentPayload;
  externalUserId?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const row = await getPaymentCodeByUserCode(input.userCode);
  if (!row) {
    return { ok: false, error: "not_found", status: 404 };
  }
  if (isPaymentCodeExpired(row)) {
    await db
      .update(x402PaymentCodes)
      .set({ status: "expired", updatedAt: new Date().toISOString() })
      .where(eq(x402PaymentCodes.id, row.id));
    return { ok: false, error: "expired", status: 410 };
  }
  if (row.status !== "pending") {
    return { ok: false, error: `invalid_status:${row.status}`, status: 409 };
  }

  const payload = x402PaymentPayloadSchema.safeParse(input.paymentPayload);
  if (!payload.success) {
    return { ok: false, error: "invalid_payload", status: 400 };
  }

  const requirements = JSON.parse(row.paymentRequirements) as X402PaymentRequirements;
  if (
    payload.data.payload.authorization.to.toLowerCase() !==
    requirements.payTo.toLowerCase()
  ) {
    return { ok: false, error: "pay_to_mismatch", status: 400 };
  }
  if (BigInt(payload.data.payload.authorization.value) < BigInt(requirements.amount)) {
    return { ok: false, error: "insufficient_value", status: 400 };
  }

  const now = new Date().toISOString();
  await db
    .update(x402PaymentCodes)
    .set({
      status: "approved",
      paymentPayload: JSON.stringify(payload.data),
      externalUserId: input.externalUserId ?? row.externalUserId,
      approvedAt: now,
      updatedAt: now,
    })
    .where(and(eq(x402PaymentCodes.id, row.id), eq(x402PaymentCodes.status, "pending")));

  return { ok: true };
}

export async function denyPaymentCode(userCode: string) {
  const row = await getPaymentCodeByUserCode(userCode);
  if (!row) {
    return null;
  }
  if (row.status !== "pending") {
    return row;
  }
  const now = new Date().toISOString();
  await db
    .update(x402PaymentCodes)
    .set({ status: "denied", updatedAt: now })
    .where(eq(x402PaymentCodes.id, row.id));
  return { ...row, status: "denied", updatedAt: now };
}

export async function consumeApprovedPaymentCode(deviceCode: string) {
  const row = await getPaymentCodeByDeviceCode(deviceCode);
  if (!row) {
    return { status: "not_found" as const };
  }
  if (isPaymentCodeExpired(row)) {
    await db
      .update(x402PaymentCodes)
      .set({ status: "expired", updatedAt: new Date().toISOString() })
      .where(eq(x402PaymentCodes.id, row.id));
    return { status: "expired" as const };
  }
  if (row.status === "pending") {
    return { status: "pending" as const };
  }
  if (row.status === "denied") {
    return { status: "denied" as const };
  }
  if (row.status === "consumed") {
    return { status: "consumed" as const };
  }
  if (row.status !== "approved" || !row.paymentPayload) {
    return { status: "invalid" as const };
  }

  const payload = JSON.parse(row.paymentPayload) as X402PaymentPayload;
  const requirements = JSON.parse(row.paymentRequirements) as X402PaymentRequirements;
  await db
    .update(x402PaymentCodes)
    .set({ status: "consumed", updatedAt: new Date().toISOString() })
    .where(eq(x402PaymentCodes.id, row.id));

  return {
    status: "approved" as const,
    paymentPayload: payload,
    paymentRequirements: requirements,
    externalUserId: row.externalUserId,
  };
}

/** Expire stale pending codes (best-effort cleanup). */
export async function expireStalePaymentCodes(): Promise<number> {
  const now = new Date().toISOString();
  const result = await db
    .update(x402PaymentCodes)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(x402PaymentCodes.status, "pending"),
        // drizzle gt on text ISO timestamps works lexicographically for ISO-8601
        // but we filter client-side via expiresAt < now by selecting then updating.
      ),
    );
  void result;
  void gt;
  const pending = await db
    .select()
    .from(x402PaymentCodes)
    .where(eq(x402PaymentCodes.status, "pending"));
  let count = 0;
  for (const row of pending) {
    if (isPaymentCodeExpired(row)) {
      await db
        .update(x402PaymentCodes)
        .set({ status: "expired", updatedAt: now })
        .where(eq(x402PaymentCodes.id, row.id));
      count += 1;
    }
  }
  return count;
}
