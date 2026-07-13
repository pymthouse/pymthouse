import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { customerPlanOverrides, plans } from "@/db/schema";

export async function getCustomerPlanOverride(input: {
  clientId: string;
  externalUserId: string;
}) {
  const rows = await db
    .select()
    .from(customerPlanOverrides)
    .where(
      and(
        eq(customerPlanOverrides.clientId, input.clientId),
        eq(customerPlanOverrides.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertCustomerPlanOverride(input: {
  clientId: string;
  externalUserId: string;
  planId: string;
  notes?: string | null;
}) {
  const planRows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, input.planId), eq(plans.clientId, input.clientId)))
    .limit(1);
  const plan = planRows[0];
  if (!plan || plan.isNetworkDefault || plan.type === "free") {
    throw new Error("Override plan must be an active billable plan for this app");
  }

  const existing = await getCustomerPlanOverride({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const now = new Date().toISOString();
  if (existing) {
    await db
      .update(customerPlanOverrides)
      .set({
        planId: input.planId,
        notes: input.notes ?? null,
        updatedAt: now,
      })
      .where(eq(customerPlanOverrides.id, existing.id));
    return { ...existing, planId: input.planId, notes: input.notes ?? null, updatedAt: now };
  }

  const row = {
    id: uuidv4(),
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    planId: input.planId,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(customerPlanOverrides).values(row);
  return row;
}

export async function deleteCustomerPlanOverride(input: {
  clientId: string;
  externalUserId: string;
}): Promise<boolean> {
  const existing = await getCustomerPlanOverride(input);
  if (!existing) {
    return false;
  }
  await db.delete(customerPlanOverrides).where(eq(customerPlanOverrides.id, existing.id));
  return true;
}

export async function listCustomerPlanOverrides(clientId: string) {
  return db
    .select()
    .from(customerPlanOverrides)
    .where(eq(customerPlanOverrides.clientId, clientId));
}
