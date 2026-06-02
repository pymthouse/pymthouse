import type { ResolvedPlanRow } from "@/lib/discovery-profile-resolve";
import { resolvePlansDiscoveryForApp } from "@/lib/discovery-profile-resolve";
import { syncPlanToOpenMeter } from "@/lib/openmeter/plans-sync";
import type { BillingProduct, BillingSyncState } from "./types";
import { toBillingProduct } from "./product-dto";

export type PlanSyncCommandResult = {
  ok: boolean;
  sync: BillingSyncState;
  openmeterPlanId?: string;
};

function syncStateFromDbPlan(
  plan: ResolvedPlanRow["plan"],
  syncResult: { ok: boolean; error?: string; openmeterPlanId?: string },
): BillingSyncState {
  if (!syncResult.ok) {
    return {
      status: "error",
      syncedAt: plan.lastSyncedAt ?? new Date().toISOString(),
      errorCode: "sync_failed",
      errorMessage: syncResult.error ?? "Sync failed",
      openmeterPlanId: plan.openmeterPlanId ?? null,
      openmeterPlanVersion: plan.openmeterPlanVersion ?? null,
    };
  }
  return {
    status: plan.type === "free" || plan.isNetworkDefault ? "not_applicable" : "synced",
    syncedAt: new Date().toISOString(),
    errorCode: null,
    errorMessage: null,
    openmeterPlanId: syncResult.openmeterPlanId ?? plan.openmeterPlanId ?? null,
    openmeterPlanVersion: plan.openmeterPlanVersion ?? null,
  };
}

export async function listBillingProducts(clientId: string): Promise<BillingProduct[]> {
  const resolved = await resolvePlansDiscoveryForApp(clientId);
  return resolved.map((row) => toBillingProduct({ clientId, resolved: row }));
}

export async function syncBillingProduct(planId: string): Promise<PlanSyncCommandResult> {
  const { db } = await import("@/db/index");
  const { plans } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");

  const sync = await syncPlanToOpenMeter(planId);
  const rows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  const plan = rows[0];
  if (!plan) {
    return {
      ok: false,
      sync: {
        status: "error",
        syncedAt: null,
        errorCode: "not_found",
        errorMessage: "Plan not found",
      },
    };
  }
  const resolved: ResolvedPlanRow = {
    plan,
    discoveryProfileId: plan.discoveryProfileId,
    discoveryPolicy: null,
    capabilities: [],
  };
  if (sync.ok) {
    const refreshed = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (refreshed[0]) {
      resolved.plan = refreshed[0];
    }
  }
  return {
    ok: sync.ok,
    sync: syncStateFromDbPlan(resolved.plan, sync),
    openmeterPlanId: sync.openmeterPlanId,
  };
}
