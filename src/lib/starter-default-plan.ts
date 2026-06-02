import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import {
  STARTER_DEFAULT_PLAN_INTERNAL_NAME,
  defaultStarterIncludedUsdMicros,
} from "@/lib/starter-default-plan-display";

export {
  STARTER_DEFAULT_PLAN_DISPLAY_NAME,
  STARTER_DEFAULT_PLAN_INTERNAL_NAME,
  defaultStarterIncludedUsdMicros,
  planDisplayNameWithStarter,
} from "@/lib/starter-default-plan-display";

export type DbExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete" | "transaction">;

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as Record<string, unknown>).code
      : undefined;
  return (
    msg.includes("unique") ||
    msg.includes("duplicate") ||
    code === "23505" ||
    code === 23505
  );
}

export async function selectStarterDefaultPlan(
  clientId: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<typeof plans.$inferSelect | undefined> {
  const rows = await executor
    .select()
    .from(plans)
    .where(and(eq(plans.clientId, clientId), eq(plans.isStarterDefault, true)))
    .limit(1);
  return rows[0];
}

export async function getOrCreateStarterPlan(
  clientId: string,
  executor: Pick<typeof db, "select" | "insert"> = db,
): Promise<typeof plans.$inferSelect> {
  const existing = await selectStarterDefaultPlan(clientId, executor);
  if (existing) {
    return existing;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    await executor.insert(plans).values({
      id,
      clientId,
      name: STARTER_DEFAULT_PLAN_INTERNAL_NAME,
      type: "usage",
      priceAmount: "0",
      priceCurrency: "USD",
      status: "active",
      includedUsdMicros: defaultStarterIncludedUsdMicros(),
      billingCycle: "monthly",
      isNetworkDefault: false,
      isStarterDefault: true,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) {
      throw err;
    }
  }
  const created = await selectStarterDefaultPlan(clientId, executor);
  if (!created) {
    throw new Error("getOrCreateStarterPlan: insert/re-read did not find starter default");
  }
  return created;
}
