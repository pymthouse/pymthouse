import type { OpenMeter, PlanReferenceInput } from "@openmeter/sdk";

import { defaultRetailRateUsd } from "@/lib/plan-pricing";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { applyFreeBillingProfileToCustomer } from "./billing-profiles";
import {
  DEFAULT_TRIAL_FEATURE_KEY,
  getHostedOpenMeterUrl,
  KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
  NETWORK_FEE_USD_MICROS_METER,
} from "./constants";
import { ensureOwnerCustomer } from "./customers";
import {
  ensureKonnectTenantCatalog,
  findKonnectFeatureIdByKey,
} from "./konnect-catalog";
import { buildKonnectUsageRateCard } from "./konnect-plan-body";
import {
  isOpenMeterConflictError,
  isOpenMeterPlanNotFoundError,
} from "./plan-errors";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  findOpenMeterSubscriptionByPlanKey,
  listOpenMeterSubscriptionsForCustomer,
  verifyOpenMeterSubscriptionId,
} from "./subscription-read";
import {
  OWNER_STARTER_PLAN_KEY,
  OWNER_STARTER_PLAN_NAME,
  isOwnerStarterPlanKey,
  ownerStarterIncludedUsdMicros,
} from "./owner-starter-key";

export {
  OWNER_STARTER_PLAN_KEY,
  OWNER_STARTER_PLAN_NAME,
  isOwnerStarterPlanKey,
  ownerStarterIncludedUsdMicros,
};

export type OwnerStarterPlanRef = {
  key: string;
  openmeterPlanId: string;
  includedUsdMicros: string;
};

function parseIncludedMicros(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return 5_000_000;
  }
  return Math.floor(n);
}

function buildOwnerStarterPlanBody(input: {
  featureId: string;
  includedUsdMicros: number;
  unitAmount: string;
}): Record<string, unknown> {
  return {
    key: OWNER_STARTER_PLAN_KEY,
    name: OWNER_STARTER_PLAN_NAME,
    currency: "USD",
    billing_cadence: "P1M",
    settlement_mode: KONNECT_SETTLEMENT_MODE_CREDIT_THEN_INVOICE,
    phases: [
      {
        key: "default",
        name: "Default",
        rate_cards: [
          buildKonnectUsageRateCard({
            key: DEFAULT_TRIAL_FEATURE_KEY,
            name: "Network usage",
            featureId: input.featureId,
            unitAmount: input.unitAmount,
            includedUsdMicros: input.includedUsdMicros,
          }),
        ],
      },
    ],
    metadata: {
      pymthouse_plan_kind: "owner_starter",
      meter_slug: NETWORK_FEE_USD_MICROS_METER,
    },
  };
}

async function findPlanByKey(
  client: OpenMeter,
  planKey: string,
): Promise<{ id: string; key?: string; version?: number } | null> {
  try {
    const listed = await client.plans.list({
      // SDK typings vary; key filter is supported by Konnect.
      ...( { key: planKey } as Record<string, unknown> ),
      page: 1,
      pageSize: 50,
    } as Parameters<OpenMeter["plans"]["list"]>[0]);
    const items = (listed as { items?: Array<{ id: string; key?: string; version?: number }> })
      ?.items ?? [];
    const exact = items.find((item) => item.key === planKey);
    if (exact?.id) {
      return exact;
    }
  } catch {
    // fall through to get-by-key
  }

  try {
    const plan = await client.plans.get(planKey);
    if (plan?.id) {
      return {
        id: plan.id,
        key: plan.key,
        version: typeof plan.version === "number" ? plan.version : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Ensure the platform Owner Starter plan exists and is published in Konnect.
 * Not a Neon `plans` row — owners share one Konnect plan across all apps.
 */
export async function ensureOwnerStarterPlanSynced(): Promise<OwnerStarterPlanRef> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }

  const includedUsdMicros = defaultStarterIncludedUsdMicros();
  const included = parseIncludedMicros(includedUsdMicros);
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey);
  if (!useKonnect) {
    throw new Error("Owner Starter plan requires Konnect metering routes");
  }

  const client = getHostedAdminClient();
  await ensureKonnectTenantCatalog();
  const featureId = await findKonnectFeatureIdByKey(DEFAULT_TRIAL_FEATURE_KEY);
  if (!featureId) {
    throw new Error(`Konnect feature missing: ${DEFAULT_TRIAL_FEATURE_KEY}`);
  }

  const existing = await findPlanByKey(client, OWNER_STARTER_PLAN_KEY);
  if (existing?.id) {
    // Publish latest draft if needed; ignore errors when already active.
    try {
      await client.plans.publish(existing.id);
    } catch {
      // already published or immutable
    }
    return {
      key: OWNER_STARTER_PLAN_KEY,
      openmeterPlanId: existing.id,
      includedUsdMicros,
    };
  }

  const body = buildOwnerStarterPlanBody({
    featureId,
    includedUsdMicros: included,
    unitAmount: defaultRetailRateUsd(),
  });

  let openmeterPlanId: string;
  try {
    const created = await client.plans.create(
      body as unknown as Parameters<OpenMeter["plans"]["create"]>[0],
    );
    if (!created?.id) {
      throw new Error("Failed to create Owner Starter plan");
    }
    openmeterPlanId = created.id;
  } catch (err) {
    if (isOpenMeterConflictError(err)) {
      const raced = await findPlanByKey(client, OWNER_STARTER_PLAN_KEY);
      if (raced?.id) {
        openmeterPlanId = raced.id;
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  try {
    const published = await client.plans.publish(openmeterPlanId);
    openmeterPlanId = published?.id ?? openmeterPlanId;
  } catch (err) {
    if (!isOpenMeterConflictError(err)) {
      // Plan may already be published.
      console.warn(
        "openmeter: owner starter plan publish",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    key: OWNER_STARTER_PLAN_KEY,
    openmeterPlanId,
    includedUsdMicros,
  };
}

/**
 * Subscribe the shared owner customer to the platform Owner Starter plan.
 * Cancels are left to migration/dedupe scripts — this only ensures one active sub.
 */
export async function ensureOwnerStarterSubscription(input: {
  ownerUserId: string;
  publicClientIds?: string[];
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<{
  openmeterSubscriptionId: string | null;
  planKey: string;
  openmeterPlanId: string;
  created: boolean;
}> {
  if (!isHostedAdminClientAvailable()) {
    return {
      openmeterSubscriptionId: null,
      planKey: OWNER_STARTER_PLAN_KEY,
      openmeterPlanId: "",
      created: false,
    };
  }

  const plan = await ensureOwnerStarterPlanSynced();
  const client = getHostedAdminClient();
  const customer = await ensureOwnerCustomer(
    client,
    input.ownerUserId,
    input.publicClientIds ?? [],
  );

  await applyFreeBillingProfileToCustomer({
    client,
    customerId: customer.id,
  });

  if (input.hintOpenMeterSubscriptionId) {
    const verified = await verifyOpenMeterSubscriptionId(
      client,
      input.hintOpenMeterSubscriptionId,
    );
    if (verified?.id) {
      return {
        openmeterSubscriptionId: verified.id,
        planKey: plan.key,
        openmeterPlanId: plan.openmeterPlanId,
        created: false,
      };
    }
  }

  const existing = await findOpenMeterSubscriptionByPlanKey(
    client,
    customer.id,
    plan.key,
    { openmeterPlanId: plan.openmeterPlanId },
  );
  if (existing?.id) {
    return {
      openmeterSubscriptionId: existing.id,
      planKey: plan.key,
      openmeterPlanId: plan.openmeterPlanId,
      created: false,
    };
  }

  // Any active subscription on the owner wallet — prefer not to stack Starters.
  try {
    const listed = await listOpenMeterSubscriptionsForCustomer(client, customer.id);
    const active = listed.find(
      (s) =>
        s.status === "active" ||
        s.status === "trialing" ||
        s.status === "scheduled" ||
        s.status === "pending" ||
        !s.status,
    );
    if (active?.id && isOwnerStarterPlanKey(active.planKey)) {
      return {
        openmeterSubscriptionId: active.id,
        planKey: plan.key,
        openmeterPlanId: plan.openmeterPlanId,
        created: false,
      };
    }
    // Non-owner-starter active sub (legacy per-app Starter) — still return it;
    // migration cancels and resubscribes onto the platform plan.
    if (active?.id) {
      return {
        openmeterSubscriptionId: active.id,
        planKey: active.planKey ?? plan.key,
        openmeterPlanId: active.planId ?? plan.openmeterPlanId,
        created: false,
      };
    }
  } catch {
    // fall through to create
  }

  const planRef = { id: plan.openmeterPlanId } as PlanReferenceInput;
  try {
    const createdSub = await client.subscriptions.create({
      customerId: customer.id,
      plan: planRef,
    });
    if (!createdSub?.id) {
      throw new Error("Failed to create Owner Starter subscription");
    }
    return {
      openmeterSubscriptionId: createdSub.id,
      planKey: plan.key,
      openmeterPlanId: plan.openmeterPlanId,
      created: true,
    };
  } catch (err) {
    if (isOpenMeterPlanNotFoundError(err)) {
      const resynced = await ensureOwnerStarterPlanSynced();
      const createdSub = await client.subscriptions.create({
        customerId: customer.id,
        plan: { id: resynced.openmeterPlanId } as PlanReferenceInput,
      });
      if (!createdSub?.id) {
        throw new Error("Failed to create Owner Starter subscription after plan sync");
      }
      return {
        openmeterSubscriptionId: createdSub.id,
        planKey: resynced.key,
        openmeterPlanId: resynced.openmeterPlanId,
        created: true,
      };
    }
    if (isOpenMeterConflictError(err)) {
      const raced = await findOpenMeterSubscriptionByPlanKey(
        client,
        customer.id,
        plan.key,
        { openmeterPlanId: plan.openmeterPlanId },
      );
      if (raced?.id) {
        return {
          openmeterSubscriptionId: raced.id,
          planKey: plan.key,
          openmeterPlanId: plan.openmeterPlanId,
          created: false,
        };
      }
    }
    throw err;
  }
}
