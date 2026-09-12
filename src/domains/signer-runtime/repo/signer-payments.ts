import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/index";
import {
  planCapabilityBundles,
  plans,
  streamSessions,
  transactions,
  usageBillingEvents,
  usageRecords,
} from "@/db/schema";

export async function getActiveStreamSessionByManifestId(manifestId: string) {
  const rows = await db
    .select()
    .from(streamSessions)
    .where(and(eq(streamSessions.manifestId, manifestId), eq(streamSessions.status, "active")))
    .limit(1);
  return rows[0] ?? null;
}

export async function createStreamSession(values: typeof streamSessions.$inferInsert) {
  await db.insert(streamSessions).values(values);
}

export async function findExistingUsageRecord(params: {
  clientId: string;
  requestId: string;
}) {
  const rows = await db
    .select()
    .from(usageRecords)
    .where(and(eq(usageRecords.clientId, params.clientId), eq(usageRecords.requestId, params.requestId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLatestActivePlanWithBundles(clientId: string) {
  const planRows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.clientId, clientId), eq(plans.status, "active")))
    .orderBy(desc(plans.updatedAt))
    .limit(1);
  const plan = planRows[0] ?? null;
  if (!plan) return { plan: null, bundles: [] };

  const bundles = await db
    .select()
    .from(planCapabilityBundles)
    .where(and(eq(planCapabilityBundles.planId, plan.id), eq(planCapabilityBundles.clientId, clientId)));
  return { plan, bundles };
}

export async function recordSignerPaymentLedger(params: {
  streamSessionId: string | null;
  feeWei: bigint;
  nowIso: string;
  pricePerUnit: bigint;
  pixelsPerUnit: bigint;
  transaction: typeof transactions.$inferInsert;
  usageRecord?: typeof usageRecords.$inferInsert;
  usageBillingEvent?: typeof usageBillingEvents.$inferInsert;
}) {
  await db.transaction(async (tx) => {
    if (params.streamSessionId) {
      await tx
        .update(streamSessions)
        .set({
          signerPaymentCount: sql`${streamSessions.signerPaymentCount} + 1`,
          totalFeeWei: sql`(${streamSessions.totalFeeWei}::numeric + ${params.feeWei.toString()}::numeric)::bigint::text`,
          lastPaymentAt: params.nowIso,
          pricePerUnit: params.pricePerUnit.toString(),
          pixelsPerUnit: params.pixelsPerUnit.toString(),
        })
        .where(eq(streamSessions.id, params.streamSessionId));
    }

    await tx.insert(transactions).values(params.transaction);

    if (params.usageRecord) {
      await tx.insert(usageRecords).values(params.usageRecord);
    }

    if (params.usageBillingEvent) {
      await tx.insert(usageBillingEvents).values(params.usageBillingEvent);
    }
  });
}
