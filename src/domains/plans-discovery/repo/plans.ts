import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { discoveryProfiles, planCapabilityBundles, plans } from "@/db/schema";
import type { CreatePlanInput, UpdatePlanInput } from "../types/plans";

async function requireOwnedDiscoveryProfile(
  appId: string,
  discoveryProfileId: string | null,
  executor: Pick<typeof db, "select"> = db,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (discoveryProfileId === null) {
    return { ok: true };
  }
  const row = await executor
    .select({ id: discoveryProfiles.id })
    .from(discoveryProfiles)
    .where(
      and(eq(discoveryProfiles.id, discoveryProfileId), eq(discoveryProfiles.clientId, appId)),
    )
    .limit(1);
  if (!row[0]) {
    return { ok: false, error: "discoveryProfileId not found for this app" };
  }
  return { ok: true };
}

export async function createPlan(appId: string, input: CreatePlanInput): Promise<string> {
  const planId = uuidv4();
  const now = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      const profCheck = await requireOwnedDiscoveryProfile(appId, input.discoveryProfileId, tx);
      if (!profCheck.ok) {
        throw Object.assign(new Error(profCheck.error), { code: "DISCOVERY_PROFILE" as const });
      }
      await tx.insert(plans).values({
        id: planId,
        clientId: appId,
        name: input.name,
        type: input.type,
        priceAmount: input.priceAmount,
        priceCurrency: input.priceCurrency,
        status: input.status,
        includedUnits: input.includedUnits !== null ? BigInt(input.includedUnits) : null,
        overageRateWei: input.overageRateWei !== null ? BigInt(input.overageRateWei) : null,
        includedUsdMicros: input.includedUsdMicros,
        generalUpchargePercentBps: input.generalUpchargePercentBps,
        payPerUseUpchargePercentBps: input.payPerUseUpchargePercentBps,
        billingCycle: input.billingCycle,
        discoveryProfileId: input.discoveryProfileId,
        createdAt: now,
        updatedAt: now,
      });

      for (const capability of input.capabilities) {
        await tx.insert(planCapabilityBundles).values({
          id: uuidv4(),
          planId,
          clientId: appId,
          pipeline: capability.pipeline,
          modelId: capability.modelId,
          slaTargetScore: capability.slaTargetScore ?? null,
          slaTargetP95Ms: capability.slaTargetP95Ms ?? null,
          maxPricePerUnit: capability.maxPricePerUnit,
          upchargePercentBps: capability.upchargePercentBps,
          createdAt: now,
        });
      }
    });
  } catch (e: unknown) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "DISCOVERY_PROFILE" &&
      e instanceof Error
    ) {
      throw new PlanValidationError(e.message);
    }
    throw e;
  }

  return planId;
}

export async function getPlanForApp(appId: string, planId: string) {
  const rows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.clientId, appId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPlansByClientId(clientId: string) {
  return db.select().from(plans).where(eq(plans.clientId, clientId));
}

export async function listPlanCapabilityBundlesByClientId(clientId: string) {
  return db
    .select()
    .from(planCapabilityBundles)
    .where(eq(planCapabilityBundles.clientId, clientId));
}

export async function updatePlan(
  appId: string,
  input: UpdatePlanInput,
): Promise<{ ok: true } | { ok: false; status: 400 | 404; error: string }> {
  const now = new Date().toISOString();
  const txnResult = await db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(plans)
      .where(and(eq(plans.id, input.id), eq(plans.clientId, appId)))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      return { tag: "notfound" as const };
    }

    if (input.discoveryProfileId !== undefined && input.discoveryProfileId !== null) {
      const profCheck = await requireOwnedDiscoveryProfile(appId, input.discoveryProfileId, tx);
      if (!profCheck.ok) {
        return { tag: "validation" as const, error: profCheck.error };
      }
    }

    const updated = await tx
      .update(plans)
      .set({
        name: input.name !== undefined ? input.name : existing.name,
        type: input.type !== undefined ? input.type : existing.type,
        priceAmount: input.priceAmount !== undefined ? input.priceAmount : existing.priceAmount,
        priceCurrency:
          input.priceCurrency !== undefined ? input.priceCurrency : existing.priceCurrency,
        status: input.status !== undefined ? input.status : existing.status,
        includedUnits: input.includedUnits !== null ? BigInt(input.includedUnits ?? "0") : null,
        overageRateWei:
          input.overageRateWei !== null ? BigInt(input.overageRateWei ?? "0") : null,
        ...(input.generalUpchargePercentBps !== undefined
          ? { generalUpchargePercentBps: input.generalUpchargePercentBps }
          : {}),
        ...(input.payPerUseUpchargePercentBps !== undefined
          ? { payPerUseUpchargePercentBps: input.payPerUseUpchargePercentBps }
          : {}),
        ...(input.includedUsdMicros !== undefined
          ? { includedUsdMicros: input.includedUsdMicros }
          : {}),
        ...(input.billingCycle !== undefined ? { billingCycle: input.billingCycle } : {}),
        ...(input.discoveryProfileId !== undefined
          ? { discoveryProfileId: input.discoveryProfileId }
          : {}),
        updatedAt: now,
      })
      .where(and(eq(plans.id, input.id), eq(plans.clientId, appId)))
      .returning({ id: plans.id });

    if (updated.length === 0) {
      return { tag: "notfound" as const };
    }

    if (input.capabilities) {
      await tx
        .delete(planCapabilityBundles)
        .where(
          and(eq(planCapabilityBundles.planId, input.id), eq(planCapabilityBundles.clientId, appId)),
        );
      for (const capability of input.capabilities) {
        await tx.insert(planCapabilityBundles).values({
          id: uuidv4(),
          planId: input.id,
          clientId: appId,
          pipeline: capability.pipeline,
          modelId: capability.modelId,
          slaTargetScore: capability.slaTargetScore ?? null,
          slaTargetP95Ms: capability.slaTargetP95Ms ?? null,
          maxPricePerUnit: capability.maxPricePerUnit,
          upchargePercentBps: capability.upchargePercentBps,
          createdAt: now,
        });
      }
    }

    return { tag: "ok" as const };
  });

  if (txnResult.tag === "notfound") {
    return { ok: false, status: 404, error: "Plan not found" };
  }
  if (txnResult.tag === "validation") {
    return { ok: false, status: 400, error: txnResult.error };
  }
  return { ok: true };
}

export async function deletePlan(
  appId: string,
  planId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const deleted = await db.transaction(async (tx) => {
    const planRows = await tx
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.id, planId), eq(plans.clientId, appId)))
      .limit(1);

    if (!planRows[0]) {
      return false;
    }

    await tx
      .delete(planCapabilityBundles)
      .where(
        and(eq(planCapabilityBundles.planId, planId), eq(planCapabilityBundles.clientId, appId)),
      );
    const removed = await tx
      .delete(plans)
      .where(and(eq(plans.id, planId), eq(plans.clientId, appId)))
      .returning({ id: plans.id });
    return removed.length > 0;
  });

  if (!deleted) {
    return { ok: false, error: "Plan not found" };
  }
  return { ok: true };
}

export class PlanValidationError extends Error {}
