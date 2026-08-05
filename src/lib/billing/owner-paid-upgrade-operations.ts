import { and, eq, isNull, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db/index";
import { ownerPaidUpgradeOperations } from "@/db/schema";

export type OwnerPaidUpgradeResult = {
  openmeterSubscriptionId: string;
  planKey: string;
  openmeterPlanId: string;
  monthlyFeeUsd: string;
  alreadyPaid: boolean;
};

const STALE_PENDING_MS = 5 * 60 * 1000;

export function ownerPaidUpgradeIdempotencyKey(
  ownerUserId: string,
  planKey: string,
): string {
  return `owner_paid_upgrade:${ownerUserId.trim()}:${planKey.trim()}`;
}

function isUniqueViolation(error: unknown): boolean {
  const codes: string[] = [];
  const messages: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (cur == null) break;
    if (cur instanceof Error) {
      messages.push(cur.message);
      const withCause = cur as Error & { cause?: unknown; code?: string };
      if (typeof withCause.code === "string") codes.push(withCause.code);
      cur = withCause.cause;
      continue;
    }
    if (typeof cur === "object") {
      const obj = cur as { message?: unknown; code?: unknown; cause?: unknown };
      if (typeof obj.message === "string") messages.push(obj.message);
      if (typeof obj.code === "string") codes.push(obj.code);
      cur = obj.cause;
      continue;
    }
    break;
  }
  if (codes.includes("23505")) return true;
  return messages.some(
    (m) =>
      m.toLowerCase().includes("unique") ||
      m.toLowerCase().includes("duplicate"),
  );
}

function isStalePending(createdAt: string, updatedAt: string): boolean {
  const anchor = Date.parse(updatedAt) || Date.parse(createdAt);
  if (!Number.isFinite(anchor)) return true;
  return Date.now() - anchor >= STALE_PENDING_MS;
}

function resultFromRow(
  row: typeof ownerPaidUpgradeOperations.$inferSelect,
): OwnerPaidUpgradeResult | null {
  if (
    !row.openmeterSubscriptionId ||
    !row.openmeterPlanId ||
    !row.monthlyFeeUsd ||
    !row.planKey
  ) {
    return null;
  }
  return {
    openmeterSubscriptionId: row.openmeterSubscriptionId,
    planKey: row.planKey,
    openmeterPlanId: row.openmeterPlanId,
    monthlyFeeUsd: row.monthlyFeeUsd,
    alreadyPaid: row.alreadyPaid === 1,
  };
}

/**
 * Claim an owner+plan Upgrade slot before calling Konnect.
 * - First caller proceeds with a pending row.
 * - Completed retries return the stored result.
 * - Fresh in-progress claims are rejected.
 * - Failed / stale pending claims may be reclaimed.
 */
export async function claimOwnerPaidUpgradeOperation(input: {
  ownerUserId: string;
  planKey: string;
}): Promise<
  | { action: "proceed"; operationId: string }
  | { action: "return"; result: OwnerPaidUpgradeResult }
  | { action: "reject"; reason: "in_progress" }
> {
  const ownerUserId = input.ownerUserId.trim();
  const planKey = input.planKey.trim();
  const idempotencyKey = ownerPaidUpgradeIdempotencyKey(ownerUserId, planKey);
  const now = new Date().toISOString();
  const operationId = randomUUID();

  try {
    await db.insert(ownerPaidUpgradeOperations).values({
      id: operationId,
      idempotencyKey,
      ownerUserId,
      planKey,
      status: "pending",
      alreadyPaid: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { action: "proceed", operationId };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  const existingRows = await db
    .select()
    .from(ownerPaidUpgradeOperations)
    .where(eq(ownerPaidUpgradeOperations.idempotencyKey, idempotencyKey))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    throw new Error("idempotency conflict without existing upgrade operation");
  }

  if (existing.status === "completed") {
    const result = resultFromRow(existing);
    if (result) {
      return { action: "return", result };
    }
  }

  if (
    existing.status === "pending" &&
    !isStalePending(existing.createdAt, existing.updatedAt)
  ) {
    return { action: "reject", reason: "in_progress" };
  }

  const staleThreshold = new Date(Date.now() - STALE_PENDING_MS).toISOString();
  const claimed = await db
    .update(ownerPaidUpgradeOperations)
    .set({
      status: "pending",
      error: null,
      openmeterSubscriptionId: null,
      openmeterPlanId: null,
      monthlyFeeUsd: null,
      alreadyPaid: 0,
      updatedAt: now,
    })
    .where(
      and(
        eq(ownerPaidUpgradeOperations.id, existing.id),
        or(
          eq(ownerPaidUpgradeOperations.status, "failed"),
          and(
            eq(ownerPaidUpgradeOperations.status, "pending"),
            lt(ownerPaidUpgradeOperations.updatedAt, staleThreshold),
          ),
          and(
            eq(ownerPaidUpgradeOperations.status, "completed"),
            isNull(ownerPaidUpgradeOperations.openmeterSubscriptionId),
          ),
        ),
      ),
    )
    .returning({ id: ownerPaidUpgradeOperations.id });

  if (claimed[0]?.id) {
    return { action: "proceed", operationId: claimed[0].id };
  }

  const again = await db
    .select()
    .from(ownerPaidUpgradeOperations)
    .where(eq(ownerPaidUpgradeOperations.idempotencyKey, idempotencyKey))
    .limit(1);
  const row = again[0];
  if (row?.status === "completed") {
    const result = resultFromRow(row);
    if (result) return { action: "return", result };
  }
  return { action: "reject", reason: "in_progress" };
}

export async function completeOwnerPaidUpgradeOperation(input: {
  operationId: string;
  result: OwnerPaidUpgradeResult;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(ownerPaidUpgradeOperations)
    .set({
      status: "completed",
      openmeterSubscriptionId: input.result.openmeterSubscriptionId,
      openmeterPlanId: input.result.openmeterPlanId,
      planKey: input.result.planKey,
      monthlyFeeUsd: input.result.monthlyFeeUsd,
      alreadyPaid: input.result.alreadyPaid ? 1 : 0,
      error: null,
      updatedAt: now,
    })
    .where(eq(ownerPaidUpgradeOperations.id, input.operationId));
}

export async function failOwnerPaidUpgradeOperation(input: {
  operationId: string;
  error: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(ownerPaidUpgradeOperations)
    .set({
      status: "failed",
      error: input.error.slice(0, 2000),
      updatedAt: now,
    })
    .where(eq(ownerPaidUpgradeOperations.id, input.operationId));
}
