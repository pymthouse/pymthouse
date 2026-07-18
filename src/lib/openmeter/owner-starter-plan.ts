import type { OpenMeter } from "@openmeter/sdk";

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
  isOpenMeterPlanAlreadyPublishedError,
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
} from "./owner-starter-key";

export {
  OWNER_STARTER_PLAN_KEY,
  OWNER_STARTER_PLAN_NAME,
  isOwnerStarterPlanKey,
  ownerStarterIncludedUsdMicros,
} from "./owner-starter-key";

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

type FoundPlan = {
  id: string;
  key?: string;
  version?: number;
  status?: string;
};

async function findPlanByKey(
  client: OpenMeter,
  planKey: string,
): Promise<FoundPlan | null> {
  try {
    const listed = await client.plans.list({
      // SDK typings vary; key filter is supported by Konnect.
      ...( { key: planKey } as Record<string, unknown> ),
      page: 1,
      pageSize: 50,
    } as Parameters<OpenMeter["plans"]["list"]>[0]);
    const items = (listed as { items?: Array<FoundPlan> })?.items ?? [];
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
        status: plan.status,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Publish is only legal for these plan states; any other state is already live. */
function planNeedsPublish(status: string | undefined): boolean {
  return status === "draft" || status === "scheduled";
}

async function publishOwnerStarterPlanBestEffort(
  client: OpenMeter,
  planId: string,
): Promise<string> {
  try {
    const published = await client.plans.publish(planId);
    return published?.id ?? planId;
  } catch (err) {
    if (
      !isOpenMeterConflictError(err) &&
      !isOpenMeterPlanAlreadyPublishedError(err)
    ) {
      console.warn(
        "openmeter: owner starter plan publish",
        err instanceof Error ? err.message : String(err),
      );
    }
    return planId;
  }
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
    if (planNeedsPublish(existing.status)) {
      await publishOwnerStarterPlanBestEffort(client, existing.id);
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
    if (!isOpenMeterConflictError(err)) {
      throw err;
    }
    const raced = await findPlanByKey(client, OWNER_STARTER_PLAN_KEY);
    if (!raced?.id) {
      throw err;
    }
    openmeterPlanId = raced.id;
  }

  openmeterPlanId = await publishOwnerStarterPlanBestEffort(client, openmeterPlanId);

  return {
    key: OWNER_STARTER_PLAN_KEY,
    openmeterPlanId,
    includedUsdMicros,
  };
}

async function findExistingOwnerWalletSubscription(input: {
  client: OpenMeter;
  customerId: string;
  planKey: string;
  openmeterPlanId: string;
  hintOpenMeterSubscriptionId?: string | null;
}): Promise<{ id: string; planKey: string; openmeterPlanId: string } | null> {
  if (input.hintOpenMeterSubscriptionId) {
    const verified = await verifyOpenMeterSubscriptionId(
      input.client,
      input.hintOpenMeterSubscriptionId,
    );
    if (verified?.id) {
      return {
        id: verified.id,
        planKey: input.planKey,
        openmeterPlanId: input.openmeterPlanId,
      };
    }
  }

  const existing = await findOpenMeterSubscriptionByPlanKey(
    input.client,
    input.customerId,
    input.planKey,
    { openmeterPlanId: input.openmeterPlanId },
  );
  if (existing?.id) {
    return {
      id: existing.id,
      planKey: input.planKey,
      openmeterPlanId: input.openmeterPlanId,
    };
  }

  try {
    const listed = await listOpenMeterSubscriptionsForCustomer(
      input.client,
      input.customerId,
    );
    const active = listed.find(
      (s) =>
        s.status === "active" ||
        s.status === "trialing" ||
        s.status === "scheduled" ||
        s.status === "pending" ||
        !s.status,
    );
    if (!active?.id) {
      return null;
    }
    if (isOwnerStarterPlanKey(active.planKey)) {
      return {
        id: active.id,
        planKey: input.planKey,
        openmeterPlanId: input.openmeterPlanId,
      };
    }
    // Legacy per-app Starter — migration cancels and resubscribes.
    return {
      id: active.id,
      planKey: active.planKey ?? input.planKey,
      openmeterPlanId: active.planId ?? input.openmeterPlanId,
    };
  } catch {
    return null;
  }
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

  const existing = await findExistingOwnerWalletSubscription({
    client,
    customerId: customer.id,
    planKey: plan.key,
    openmeterPlanId: plan.openmeterPlanId,
    hintOpenMeterSubscriptionId: input.hintOpenMeterSubscriptionId,
  });
  if (existing) {
    return {
      openmeterSubscriptionId: existing.id,
      planKey: existing.planKey,
      openmeterPlanId: existing.openmeterPlanId,
      created: false,
    };
  }

  // Plan key is the SDK PlanReferenceInput contract.
  try {
    const createdSub = await client.subscriptions.create({
      customerId: customer.id,
      plan: { key: plan.key },
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
        plan: { key: resynced.key },
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
