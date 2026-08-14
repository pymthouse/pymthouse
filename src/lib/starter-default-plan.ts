import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients, plans } from "@/db/schema";
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

/**
 * `plans.client_id` is `developer_apps.id`. Callers often pass the public
 * `app_…` oidc client id; resolve that before insert/lookup.
 */
export async function resolveDeveloperAppIdForPlans(
  clientIdOrPublic: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<string> {
  const trimmed = clientIdOrPublic.trim();
  if (!trimmed) return trimmed;

  const byId = await executor
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(eq(developerApps.id, trimmed))
    .limit(1);
  if (byId[0]?.id) return byId[0].id;

  const byPublic = await executor
    .select({ id: developerApps.id })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, trimmed))
    .limit(1);
  if (byPublic[0]?.id) return byPublic[0].id;

  return trimmed;
}

async function selectStarterDefaultPlanByClientId(
  clientId: string,
  executor: Pick<typeof db, "select">,
): Promise<typeof plans.$inferSelect | undefined> {
  const rows = await executor
    .select()
    .from(plans)
    .where(and(eq(plans.clientId, clientId), eq(plans.isStarterDefault, true)))
    .limit(1);
  return rows[0];
}

export async function selectStarterDefaultPlan(
  clientId: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<typeof plans.$inferSelect | undefined> {
  const resolved = await resolveDeveloperAppIdForPlans(clientId, executor);
  const byResolved = await selectStarterDefaultPlanByClientId(resolved, executor);
  if (byResolved) return byResolved;
  if (resolved !== clientId.trim()) {
    return selectStarterDefaultPlanByClientId(clientId.trim(), executor);
  }
  return undefined;
}

export async function getOrCreateStarterPlan(
  clientId: string,
  executor: Pick<typeof db, "select" | "insert"> = db,
): Promise<typeof plans.$inferSelect> {
  const plansClientId = await resolveDeveloperAppIdForPlans(clientId, executor);
  const existing = await selectStarterDefaultPlan(clientId, executor);
  if (existing) {
    return existing;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    await executor.insert(plans).values({
      id,
      clientId: plansClientId,
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
