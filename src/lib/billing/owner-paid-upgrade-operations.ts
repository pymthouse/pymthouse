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
  collectErrorCodesAndMessages(error, codes, messages, 0);
  if (codes.includes("23505")) return true;
  return messages.some((m) => {
    const lower = m.toLowerCase();
    // Constraint-shaped only — avoid matching "unique"/"duplicate" in prose.
    return (
      /\bunique (constraint|violation|index)\b/.test(lower) ||
      /\bduplicate key\b/.test(lower) ||
      /\bviolates unique constraint\b/.test(lower)
    );
  });
}

function collectErrorCodesAndMessages(
  cur: unknown,
  codes: string[],
  messages: string[],
  depth: number,
): void {
  if (cur == null || depth >= 4) return;
  if (cur instanceof Error) {
    messages.push(cur.message);
    const withCause = cur as Error & { cause?: unknown; code?: string };
    if (typeof withCause.code === "string") codes.push(withCause.code);
    collectErrorCodesAndMessages(withCause.cause, codes, messages, depth + 1);
    return;
  }
  if (typeof cur === "object") {
    const obj = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof obj.message === "string") messages.push(obj.message);
    if (typeof obj.code === "string") codes.push(obj.code);
    collectErrorCodesAndMessages(obj.cause, codes, messages, depth + 1);
  }
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

function completedRowIncomplete(): ReturnType<typeof and> {
  return and(
    eq(ownerPaidUpgradeOperations.status, "completed"),
    or(
      isNull(ownerPaidUpgradeOperations.openmeterSubscriptionId),
      isNull(ownerPaidUpgradeOperations.openmeterPlanId),
      isNull(ownerPaidUpgradeOperations.monthlyFeeUsd),
      isNull(ownerPaidUpgradeOperations.planKey),
    ),
  );
}

async function tryReclaimOwnerPaidUpgradeOperation(input: {
  existingId: string;
  reclaimCompletedForPlanChange: boolean;
  now: string;
}): Promise<string | null> {
  const staleThreshold = new Date(Date.now() - STALE_PENDING_MS).toISOString();
  const reclaimConditions = [
    eq(ownerPaidUpgradeOperations.status, "failed"),
    and(
      eq(ownerPaidUpgradeOperations.status, "pending"),
      lt(ownerPaidUpgradeOperations.updatedAt, staleThreshold),
    ),
    completedRowIncomplete(),
  ];
  if (input.reclaimCompletedForPlanChange) {
    reclaimConditions.push(eq(ownerPaidUpgradeOperations.status, "completed"));
  }

  const claimed = await db
    .update(ownerPaidUpgradeOperations)
    .set({
      status: "pending",
      error: null,
      openmeterSubscriptionId: null,
      openmeterPlanId: null,
      monthlyFeeUsd: null,
      alreadyPaid: 0,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(ownerPaidUpgradeOperations.id, input.existingId),
        or(...reclaimConditions),
      ),
    )
    .returning({ id: ownerPaidUpgradeOperations.id });

  return claimed[0]?.id ?? null;
}

function completedResultOrNull(
  row: typeof ownerPaidUpgradeOperations.$inferSelect,
  reclaimCompletedForPlanChange: boolean,
): OwnerPaidUpgradeResult | null {
  if (row.status !== "completed") return null;
  const result = resultFromRow(row);
  if (result && !reclaimCompletedForPlanChange) return result;
  return null;
}

async function resolveConflictingUpgradeClaim(input: {
  idempotencyKey: string;
  reclaimCompletedForPlanChange: boolean;
  now: string;
}): Promise<
  | { action: "proceed"; operationId: string }
  | { action: "return"; result: OwnerPaidUpgradeResult }
  | { action: "reject"; reason: "in_progress" }
> {
  const existingRows = await db
    .select()
    .from(ownerPaidUpgradeOperations)
    .where(eq(ownerPaidUpgradeOperations.idempotencyKey, input.idempotencyKey))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    throw new Error("idempotency conflict without existing upgrade operation");
  }

  const completed = completedResultOrNull(
    existing,
    input.reclaimCompletedForPlanChange,
  );
  if (completed) {
    return { action: "return", result: completed };
  }

  if (
    existing.status === "pending" &&
    !isStalePending(existing.createdAt, existing.updatedAt)
  ) {
    return { action: "reject", reason: "in_progress" };
  }

  const reclaimedId = await tryReclaimOwnerPaidUpgradeOperation({
    existingId: existing.id,
    reclaimCompletedForPlanChange: input.reclaimCompletedForPlanChange,
    now: input.now,
  });
  if (reclaimedId) {
    return { action: "proceed", operationId: reclaimedId };
  }

  const again = await db
    .select()
    .from(ownerPaidUpgradeOperations)
    .where(eq(ownerPaidUpgradeOperations.idempotencyKey, input.idempotencyKey))
    .limit(1);
  const row = again[0];
  if (row) {
    const againCompleted = completedResultOrNull(
      row,
      input.reclaimCompletedForPlanChange,
    );
    if (againCompleted) {
      return { action: "return", result: againCompleted };
    }
  }
  return { action: "reject", reason: "in_progress" };
}

/**
 * Claim an owner+plan Upgrade slot before calling Konnect.
 * - First caller proceeds with a pending row.
 * - Completed retries return the stored result when still on that plan.
 * - Fresh in-progress claims are rejected.
 * - Failed / stale pending / incomplete completed claims may be reclaimed.
 * - Completed claims for a plan may be reclaimed when `currentPlanKey` differs
 *   (A → B → A) so the unique owner/plan row no longer blocks re-selection.
 */
export async function claimOwnerPaidUpgradeOperation(input: {
  ownerUserId: string;
  planKey: string;
  /**
   * Active OpenMeter plan key for the owner wallet. When set and different from
   * `planKey`, a completed claim for `planKey` is reclaimed instead of returned.
   */
  currentPlanKey?: string | null;
}): Promise<
  | { action: "proceed"; operationId: string }
  | { action: "return"; result: OwnerPaidUpgradeResult }
  | { action: "reject"; reason: "in_progress" }
> {
  const ownerUserId = input.ownerUserId.trim();
  const planKey = input.planKey.trim();
  const currentPlanKey = input.currentPlanKey?.trim() || "";
  const reclaimCompletedForPlanChange =
    Boolean(currentPlanKey) && currentPlanKey !== planKey;
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

  return resolveConflictingUpgradeClaim({
    idempotencyKey,
    reclaimCompletedForPlanChange,
    now,
  });
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
