/**
 * End-user subscription history (OpenMeter supersession chain).
 *
 * Lookup-only — does not create customers. Each plan change closes the prior
 * subscription and opens a successor; this lists the full chain for Settings.
 */
import { eq } from "drizzle-orm";
import type { OpenMeter } from "@openmeter/sdk";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { resolveAppUserSubscriptionPlanName } from "@/lib/billing/app-user-subscription-display";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import { findOpenMeterCustomerByKey } from "@/lib/openmeter/customers";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plan-naming";
import { isLiveSubscriptionStatus } from "@/lib/openmeter/subscription-state";
import {
  enrichSubscriptionActiveWindow,
  listOpenMeterSubscriptionsForCustomer,
  type OpenMeterSubscriptionView,
} from "@/lib/openmeter/subscription-read";

export type AppUserSubscriptionHistoryItem = {
  id: string;
  status: string;
  /** True when this row is the live (active/trialing) subscription. */
  current: boolean;
  planId: string | null;
  planName: string | null;
  planKey: string | null;
  openmeterPlanId: string | null;
  activeFrom: string | null;
  activeTo: string | null;
};

export type ListAppUserSubscriptionHistoryResult = {
  items: AppUserSubscriptionHistoryItem[];
  externalUserId: string;
};

type LocalPlanRow = {
  id: string;
  name: string;
  isStarterDefault: boolean;
  openmeterPlanId: string | null;
};

function compareActiveFromDesc(
  a: Pick<AppUserSubscriptionHistoryItem, "activeFrom" | "id">,
  b: Pick<AppUserSubscriptionHistoryItem, "activeFrom" | "id">,
): number {
  const aTs = a.activeFrom ? Date.parse(a.activeFrom) : Number.NaN;
  const bTs = b.activeFrom ? Date.parse(b.activeFrom) : Number.NaN;
  const aOk = Number.isFinite(aTs);
  const bOk = Number.isFinite(bTs);
  if (aOk && bOk && bTs !== aTs) {
    return bTs - aTs;
  }
  if (aOk !== bOk) {
    return aOk ? -1 : 1;
  }
  return b.id.localeCompare(a.id);
}

/** @internal Exported for unit tests. */
export function sortSubscriptionHistoryItems(
  items: AppUserSubscriptionHistoryItem[],
): AppUserSubscriptionHistoryItem[] {
  return [...items].sort(compareActiveFromDesc);
}

function matchLocalPlan(
  sub: OpenMeterSubscriptionView,
  byOpenMeterId: Map<string, LocalPlanRow>,
  byPlanKey: Map<string, LocalPlanRow>,
): LocalPlanRow | null {
  if (sub.planId) {
    const byId = byOpenMeterId.get(sub.planId);
    if (byId) return byId;
  }
  if (sub.planKey) {
    return byPlanKey.get(sub.planKey) ?? null;
  }
  return null;
}

async function loadLocalPlans(appId: string): Promise<{
  byOpenMeterId: Map<string, LocalPlanRow>;
  byPlanKey: Map<string, LocalPlanRow>;
}> {
  const rows = await db
    .select({
      id: plans.id,
      name: plans.name,
      isStarterDefault: plans.isStarterDefault,
      openmeterPlanId: plans.openmeterPlanId,
    })
    .from(plans)
    .where(eq(plans.clientId, appId));

  const byOpenMeterId = new Map<string, LocalPlanRow>();
  const byPlanKey = new Map<string, LocalPlanRow>();
  for (const row of rows) {
    const local: LocalPlanRow = {
      id: row.id,
      name: row.name,
      isStarterDefault: row.isStarterDefault === true,
      openmeterPlanId: row.openmeterPlanId,
    };
    if (local.openmeterPlanId?.trim()) {
      byOpenMeterId.set(local.openmeterPlanId.trim(), local);
    }
    byPlanKey.set(buildOpenMeterPlanKey(appId, local.id), local);
  }
  return { byOpenMeterId, byPlanKey };
}

function toHistoryItem(
  sub: OpenMeterSubscriptionView,
  local: LocalPlanRow | null,
): AppUserSubscriptionHistoryItem {
  const planName = resolveAppUserSubscriptionPlanName({
    plan: local
      ? {
          id: local.id,
          name: local.name,
          type: "",
          status: "active",
          phaseOutAt: null,
          replacementPlanId: null,
          isStarterDefault: local.isStarterDefault,
        }
      : null,
    planKey: sub.planKey,
  });
  return {
    id: sub.id,
    status: sub.status,
    current: isLiveSubscriptionStatus(sub.status),
    planId: local?.id ?? null,
    planName,
    planKey: sub.planKey,
    openmeterPlanId: sub.planId,
    activeFrom: sub.activeFrom,
    activeTo: sub.activeTo,
  };
}

async function lookupCustomerId(
  client: OpenMeter,
  clientId: string,
  externalUserId: string,
): Promise<string | null> {
  const publicClientId = await resolveOpenMeterMeterClientId(clientId);
  const key = buildOpenMeterCustomerKey(publicClientId, externalUserId);
  const existing = await findOpenMeterCustomerByKey(client, key);
  return existing?.id?.trim() || null;
}

/**
 * Full subscription supersession history for an app end-user.
 * Newest `activeFrom` first. Empty when OpenMeter is offline or the customer
 * does not exist yet.
 */
export async function listAppUserSubscriptionHistory(input: {
  clientId: string;
  externalUserId: string;
}): Promise<ListAppUserSubscriptionHistoryResult> {
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  const empty: ListAppUserSubscriptionHistoryResult = {
    items: [],
    externalUserId,
  };
  if (!clientId || !externalUserId || !isHostedAdminClientAvailable()) {
    return empty;
  }

  const client = getHostedAdminClient();
  const customerId = await lookupCustomerId(client, clientId, externalUserId);
  if (!customerId) {
    return empty;
  }

  const [listed, localIndexes] = await Promise.all([
    listOpenMeterSubscriptionsForCustomer(client, customerId),
    loadLocalPlans(clientId),
  ]);

  const enriched = await Promise.all(
    listed.map((item) => enrichSubscriptionActiveWindow(item)),
  );

  const items = sortSubscriptionHistoryItems(
    enriched.map((sub) =>
      toHistoryItem(
        sub,
        matchLocalPlan(sub, localIndexes.byOpenMeterId, localIndexes.byPlanKey),
      ),
    ),
  );

  return { items, externalUserId };
}
