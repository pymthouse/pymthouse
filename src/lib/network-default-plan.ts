import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { planCapabilityBundles, plans } from "@/db/schema";
import {
  expandDocumentToConcreteKeys,
  fullCatalogConcreteKeys,
  isDiscoveryDocumentEmpty,
  normalizeDiscoveryAllowlistDoc,
  type DiscoveryAllowlistCapability,
  type DiscoveryAllowlistDocument,
  type PipelineCatalogEntryLite,
} from "@/lib/discovery-allowlist";
import {
  NETWORK_DEFAULT_PLAN_INTERNAL_NAME,
  planDisplayName,
} from "@/lib/network-default-plan-display";

export {
  NETWORK_DEFAULT_PLAN_DISPLAY_NAME,
  NETWORK_DEFAULT_PLAN_INTERNAL_NAME,
  planDisplayName,
} from "@/lib/network-default-plan-display";

export type DbExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete" | "transaction">;

function excludedDocFromPlanRow(
  raw: typeof plans.$inferSelect["discoveryExcludedCapabilities"],
): DiscoveryAllowlistDocument | null {
  return normalizeDiscoveryAllowlistDoc(raw ?? null);
}

/** Concrete `pipeline|modelId` keys implied by billing capability rows. */
export function expandCapabilityRowsToConcreteKeys(
  catalog: PipelineCatalogEntryLite[],
  caps: DiscoveryAllowlistCapability[],
): Set<string> {
  return expandDocumentToConcreteKeys({ capabilities: caps }, catalog);
}

export function getDiscoverableConcreteKeys(
  catalog: PipelineCatalogEntryLite[],
  excluded: DiscoveryAllowlistDocument | null,
): Set<string> {
  const all = fullCatalogConcreteKeys(catalog);
  if (isDiscoveryDocumentEmpty(excluded)) {
    return all;
  }
  const ex = expandDocumentToConcreteKeys(excluded!, catalog);
  return new Set([...all].filter((k) => !ex.has(k)));
}

export async function selectNetworkDefaultPlan(
  clientId: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<typeof plans.$inferSelect | undefined> {
  const rows = await executor
    .select()
    .from(plans)
    .where(and(eq(plans.clientId, clientId), eq(plans.isNetworkDefault, true)))
    .limit(1);
  return rows[0];
}

export async function getOrCreateNetworkDefaultPlan(
  clientId: string,
  executor: Pick<typeof db, "select" | "insert"> = db,
): Promise<typeof plans.$inferSelect> {
  const existing = await selectNetworkDefaultPlan(clientId, executor);
  if (existing) {
    return existing;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  await executor.insert(plans).values({
    id,
    clientId,
    name: NETWORK_DEFAULT_PLAN_INTERNAL_NAME,
    type: "free",
    priceAmount: "0",
    priceCurrency: "USD",
    status: "active",
    billingCycle: "monthly",
    isNetworkDefault: true,
    discoveryExcludedCapabilities: null,
    createdAt: now,
    updatedAt: now,
  });
  const created = await selectNetworkDefaultPlan(clientId, executor);
  if (!created) {
    throw new Error("getOrCreateNetworkDefaultPlan: insert did not persist");
  }
  return created;
}

export type UndiscoverableCapabilityConflict = {
  pipeline: string;
  modelId: string;
};

export function assertCapabilityRowsDiscoverable(
  catalog: PipelineCatalogEntryLite[],
  discoverable: Set<string>,
  capabilityRows: DiscoveryAllowlistCapability[],
):
  | { ok: true }
  | { ok: false; conflicts: UndiscoverableCapabilityConflict[] } {
  const expanded = expandCapabilityRowsToConcreteKeys(catalog, capabilityRows);
  const conflicts: UndiscoverableCapabilityConflict[] = [];
  for (const k of expanded) {
    if (!discoverable.has(k)) {
      const sep = k.indexOf("|");
      conflicts.push({ pipeline: k.slice(0, sep), modelId: k.slice(sep + 1) });
    }
  }
  if (conflicts.length === 0) return { ok: true };
  conflicts.sort((a, b) =>
    a.pipeline === b.pipeline
      ? a.modelId.localeCompare(b.modelId)
      : a.pipeline.localeCompare(b.pipeline),
  );
  return { ok: false, conflicts };
}

export type ExclusionBlockedByPlan = {
  planId: string;
  planName: string;
  pipeline: string;
  modelId: string;
};

/**
 * When tightening Network Price exclusions, list custom-plan bundles that would
 * reference a pipeline/model that becomes non-discoverable.
 */
export async function findCustomPlansBlockingNewExclusions(
  clientId: string,
  catalog: PipelineCatalogEntryLite[],
  newExcludedDoc: DiscoveryAllowlistDocument | null,
  executor: Pick<typeof db, "select"> = db,
): Promise<ExclusionBlockedByPlan[]> {
  const afterDiscoverable = getDiscoverableConcreteKeys(catalog, newExcludedDoc);
  const customPlans = await executor
    .select({
      planId: plans.id,
      planName: plans.name,
      isNetworkDefault: plans.isNetworkDefault,
    })
    .from(plans)
    .where(and(eq(plans.clientId, clientId), eq(plans.isNetworkDefault, false)));

  const planById = new Map(customPlans.map((p) => [p.planId, p]));

  const bundles = await executor
    .select()
    .from(planCapabilityBundles)
    .where(eq(planCapabilityBundles.clientId, clientId));

  const out: ExclusionBlockedByPlan[] = [];
  for (const b of bundles) {
    const p = planById.get(b.planId);
    if (!p) continue;
    const keys = expandCapabilityRowsToConcreteKeys(catalog, [
      { pipeline: b.pipeline, modelId: b.modelId },
    ]);
    for (const k of keys) {
      if (!afterDiscoverable.has(k)) {
        out.push({
          planId: b.planId,
          planName: planDisplayName({ name: p.planName, isNetworkDefault: p.isNetworkDefault }),
          pipeline: b.pipeline,
          modelId: b.modelId,
        });
      }
    }
  }
  return out;
}

export async function loadDiscoverableSetForApp(
  clientId: string,
  catalog: PipelineCatalogEntryLite[],
  executor: Pick<typeof db, "select"> = db,
): Promise<Set<string>> {
  const row = await selectNetworkDefaultPlan(clientId, executor);
  const excluded = excludedDocFromPlanRow(row?.discoveryExcludedCapabilities ?? null);
  return getDiscoverableConcreteKeys(catalog, excluded);
}
