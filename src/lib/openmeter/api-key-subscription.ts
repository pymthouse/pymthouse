import { and, eq } from "drizzle-orm";
import type { OpenMeter } from "@openmeter/sdk";
import { db } from "@/db/index";
import { apiKeys, subscriptions } from "@/db/schema";
import { isOpenMeterUlid } from "./konnect-routes";
import {
  isOpenMeterSubscriptionActive,
  resolveLocalPlanIdFromOpenMeterSubscription,
  verifyOpenMeterSubscriptionId,
  type OpenMeterSubscriptionView,
} from "./subscription-read";

type ApiKeyRow = typeof apiKeys.$inferSelect;

export type ResolvedApiKeySubscription = {
  openmeterSubscriptionId: string;
  openmeterSubscription: OpenMeterSubscriptionView;
  planId: string | null;
};

export async function resolveApiKeyOpenMeterSubscription(input: {
  apiKey: ApiKeyRow;
  client: OpenMeter;
}): Promise<ResolvedApiKeySubscription | null> {
  let openmeterSubscriptionId =
    input.apiKey.openmeterSubscriptionId?.trim() || null;

  let legacyPlanId: string | null = null;
  if (!openmeterSubscriptionId && input.apiKey.subscriptionId) {
    if (isOpenMeterUlid(input.apiKey.subscriptionId)) {
      openmeterSubscriptionId = input.apiKey.subscriptionId;
    } else {
      const subRows = await db
        .select({
          openmeterSubscriptionId: subscriptions.openmeterSubscriptionId,
          planId: subscriptions.planId,
        })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.id, input.apiKey.subscriptionId),
            eq(subscriptions.clientId, input.apiKey.clientId),
          ),
        )
        .limit(1);
      openmeterSubscriptionId = subRows[0]?.openmeterSubscriptionId ?? null;
      legacyPlanId = subRows[0]?.planId ?? null;
    }
  }

  if (!openmeterSubscriptionId) {
    return null;
  }

  const omSub = await verifyOpenMeterSubscriptionId(input.client, openmeterSubscriptionId);
  if (!omSub || !isOpenMeterSubscriptionActive(omSub.status)) {
    return null;
  }

  const planId =
    legacyPlanId ??
    (await resolveLocalPlanIdFromOpenMeterSubscription(input.apiKey.clientId, omSub));

  return {
    openmeterSubscriptionId,
    openmeterSubscription: omSub,
    planId,
  };
}

export { buildOpenMeterPlanKey } from "./plan-naming";
