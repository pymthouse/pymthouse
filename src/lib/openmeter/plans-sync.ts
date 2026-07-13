import type { OpenMeter } from "@openmeter/sdk";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { planCapabilityBundles, plans } from "@/db/schema";
import { getHostedOpenMeterUrl, DEFAULT_TRIAL_FEATURE_KEY, NETWORK_FEE_USD_MICROS_METER } from "./constants";
import {
  ensureKonnectTenantCatalog,
  findKonnectFeatureIdByKey,
  unwrapOpenMeterListResult,
} from "./konnect-catalog";
import {
  buildKonnectFlatFeeRateCard,
  buildKonnectUsageRateCard,
} from "./konnect-plan-body";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  defaultRetailRateUsd,
  parseRetailRateUsd,
} from "@/lib/plan-pricing";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";
import { getBillingClientForApp, getHostedAdminClient, isBillingClientAvailableForApp } from "./admin-client";
import { ensureCapabilityOpenMeterFeature } from "./capability-features";
import {
  isOpenMeterPlanImmutableError,
  isOpenMeterPlanNotFoundError,
} from "./plan-errors";
import {
  buildOpenMeterPlanKey,
  openMeterCapabilityLabel,
  toOpenMeterDisplayName,
} from "./plan-naming";

export { isOpenMeterPlanImmutableError, isOpenMeterPlanNotFoundError } from "./plan-errors";
export { buildOpenMeterPlanKey } from "./plan-naming";

function parseIncludedMicros(raw: string | null | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  } catch {
    return undefined;
  }
}

function resolvePlanIncludedMicros(plan: typeof plans.$inferSelect): number | undefined {
  return (
    parseIncludedMicros(plan.includedUsdMicros) ??
    (plan.isStarterDefault ? parseIncludedMicros(defaultStarterIncludedUsdMicros()) : undefined)
  );
}

function parsePriceAmount(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return "0";
  }
  return n.toFixed(2);
}

function resolvePlanRetailRateUsd(plan: typeof plans.$inferSelect): string {
  return parseRetailRateUsd(plan.overageRateUsd) ?? defaultRetailRateUsd();
}

function resolveCapabilityRetailRateUsd(input: {
  plan: typeof plans.$inferSelect;
  retailRateUsd: string | null;
}): string {
  return parseRetailRateUsd(input.retailRateUsd) ?? resolvePlanRetailRateUsd(input.plan);
}

async function resolveOpenMeterFeatureId(
  client: OpenMeter,
  featureKey: string,
): Promise<string> {
  const useKonnectBody = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );

  if (useKonnectBody) {
    await ensureKonnectTenantCatalog();
    const featureId = await findKonnectFeatureIdByKey(featureKey);
    if (!featureId) {
      throw new Error(`OpenMeter feature not found: ${featureKey}`);
    }
    return featureId;
  }

  const features = unwrapOpenMeterListResult<{ id: string; key: string }>(
    await client.features.list(),
  );
  const match = features.find((feature) => feature.key === featureKey);
  if (!match?.id) {
    throw new Error(`OpenMeter feature not found: ${featureKey}`);
  }
  return match.id;
}

function buildUsageRateCard(input: {
  key: string;
  name: string;
  featureKey: string;
  unitAmount: string;
  includedMicros?: number;
  includeEntitlement?: boolean;
}): Record<string, unknown> {
  return {
    type: "usage_based",
    key: input.key,
    name: input.name,
    featureKey: input.featureKey,
    billingCadence: "P1M",
    price: {
      type: "unit",
      amount: input.unitAmount,
    },
    entitlementTemplate:
      input.includeEntitlement && input.includedMicros
        ? {
            type: "metered",
            isSoftLimit: false,
            issueAfterReset: input.includedMicros,
            issueAfterResetPriority: 1,
          }
        : undefined,
  };
}

async function appendDefaultTrialUsageRateCard(input: {
  omClient: OpenMeter;
  plan: typeof plans.$inferSelect;
  planRetail: string;
  includedMicros?: number;
  rateCards: Array<Record<string, unknown>>;
  useKonnectBody: boolean;
}): Promise<void> {
  if (input.useKonnectBody) {
    const featureId = await resolveOpenMeterFeatureId(input.omClient, DEFAULT_TRIAL_FEATURE_KEY);
    // Starter trial credits are prepaid via /credits/grants. Paid plans use
    // rate-card discounts.usage so included allowance is part of the catalog.
    const includeUsageDiscount =
      !input.plan.isStarterDefault &&
      input.includedMicros != null &&
      input.includedMicros > 0;
    input.rateCards.push(
      buildKonnectUsageRateCard({
        key: DEFAULT_TRIAL_FEATURE_KEY,
        name: "Network usage",
        featureId,
        unitAmount: input.planRetail,
        includedMicros: includeUsageDiscount ? input.includedMicros : undefined,
      }),
    );
    return;
  }

  input.rateCards.push(
    buildUsageRateCard({
      key: DEFAULT_TRIAL_FEATURE_KEY,
      name: "Network usage",
      featureKey: DEFAULT_TRIAL_FEATURE_KEY,
      unitAmount: input.planRetail,
      includedMicros: input.includedMicros,
      includeEntitlement: true,
    }),
  );
}

async function appendCapabilityRateCards(input: {
  clientId: string;
  plan: typeof plans.$inferSelect;
  omClient: OpenMeter;
  capabilityRows: Array<typeof planCapabilityBundles.$inferSelect>;
  includedMicros?: number;
  planRetail: string;
  rateCards: Array<Record<string, unknown>>;
  useKonnectBody: boolean;
}): Promise<void> {
  let entitlementAssigned = false;
  for (const cap of input.capabilityRows) {
    const retail = resolveCapabilityRetailRateUsd({
      plan: input.plan,
      retailRateUsd: cap.retailRateUsd,
    });
    const featureKey = await ensureCapabilityOpenMeterFeature({
      client: input.omClient,
      clientId: input.clientId,
      planId: input.plan.id,
      pipeline: cap.pipeline,
      modelId: cap.modelId,
      displayName: openMeterCapabilityLabel({
        pipeline: cap.pipeline,
        modelId: cap.modelId,
      }),
      preferredKey: cap.openmeterFeatureKey,
    });
    if (input.useKonnectBody) {
      const featureId = await resolveOpenMeterFeatureId(input.omClient, featureKey);
      // Starter trial credits are prepaid via /credits/grants. Paid plans attach
      // includedMicros as discounts.usage on the first capability rate card.
      const includeUsageDiscount =
        !input.plan.isStarterDefault &&
        !entitlementAssigned &&
        input.includedMicros != null &&
        input.includedMicros > 0;
      input.rateCards.push(
        buildKonnectUsageRateCard({
          key: featureKey,
          name: openMeterCapabilityLabel({
            pipeline: cap.pipeline,
            modelId: cap.modelId,
          }),
          featureId,
          unitAmount: retail,
          includedMicros: includeUsageDiscount ? input.includedMicros : undefined,
        }),
      );
    } else {
      input.rateCards.push(
        buildUsageRateCard({
          key: featureKey,
          name: openMeterCapabilityLabel({
            pipeline: cap.pipeline,
            modelId: cap.modelId,
          }),
          featureKey,
          unitAmount: retail,
          includedMicros: entitlementAssigned ? undefined : input.includedMicros,
          includeEntitlement: !entitlementAssigned,
        }),
      );
    }
    entitlementAssigned = entitlementAssigned || Boolean(input.includedMicros);
  }
}

export async function mapPymthousePlanToOpenMeterCreate(input: {
  clientId: string;
  plan: typeof plans.$inferSelect;
  capabilities: Array<typeof planCapabilityBundles.$inferSelect>;
  client?: Awaited<ReturnType<typeof getBillingClientForApp>>;
}) {
  const { plan } = input;
  if (plan.type === "free" || plan.isNetworkDefault) {
    return null;
  }

  const omClient = input.client ?? (await getBillingClientForApp(input.clientId));
  const rateCards: Array<Record<string, unknown>> = [];
  const includedMicros = resolvePlanIncludedMicros(plan);
  const planRetail = resolvePlanRetailRateUsd(plan);
  const useKonnectBody = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );

  if (plan.type === "subscription") {
    const flatAmount = parsePriceAmount(plan.priceAmount);
    if (flatAmount !== "0") {
      rateCards.push(
        useKonnectBody
          ? buildKonnectFlatFeeRateCard({
              key: "subscription_fee",
              name: `${toOpenMeterDisplayName(plan.name)} subscription`,
              amount: flatAmount,
            })
          : {
              type: "flat_fee",
              key: "subscription_fee",
              name: `${toOpenMeterDisplayName(plan.name)} subscription`,
              billingCadence: "P1M",
              price: {
                type: "flat",
                amount: flatAmount,
                paymentTerm: "in_advance",
              },
            },
      );
    }
  }

  const capabilityRows = input.capabilities.filter((c) => c.planId === plan.id);

  if (capabilityRows.length === 0) {
    await appendDefaultTrialUsageRateCard({
      omClient,
      plan,
      planRetail,
      includedMicros,
      rateCards,
      useKonnectBody,
    });
  } else {
    await appendCapabilityRateCards({
      clientId: input.clientId,
      plan,
      omClient,
      capabilityRows,
      includedMicros,
      planRetail,
      rateCards,
      useKonnectBody,
    });
  }

  const planKey = buildOpenMeterPlanKey(input.clientId, plan.id);
  const planName = toOpenMeterDisplayName(plan.name);
  const currency = (plan.priceCurrency || "USD").toUpperCase() as "USD";
  const trialDuration =
    typeof plan.trialPhaseDuration === "string" && /^P\d+[DWMY]$/i.test(plan.trialPhaseDuration.trim())
      ? plan.trialPhaseDuration.trim().toUpperCase()
      : null;

  if (useKonnectBody) {
    const phases: Array<Record<string, unknown>> = [];
    if (trialDuration) {
      phases.push({
        key: "trial",
        name: "Trial",
        duration: trialDuration,
        rate_cards: rateCards.map((card) => ({
          ...card,
          // Trial phase: keep usage features but zero out flat subscription fees.
          price:
            card.key === "subscription_fee"
              ? { type: "flat", amount: "0" }
              : card.price,
        })),
      });
    }
    phases.push({
      key: "default",
      name: "Default",
      rate_cards: rateCards,
    });
    return {
      key: planKey,
      name: planName,
      currency,
      billing_cadence: "P1M",
      phases,
      metadata: {
        pymthouse_client_id: input.clientId,
        pymthouse_plan_id: plan.id,
        meter_slug: NETWORK_FEE_USD_MICROS_METER,
      },
    };
  }

  const phases: Array<Record<string, unknown>> = [];
  if (trialDuration) {
    phases.push({
      key: "trial",
      name: "Trial",
      duration: trialDuration,
      rateCards: rateCards.map((card) =>
        card.type === "flat_fee"
          ? {
              ...card,
              price: {
                type: "flat",
                amount: "0",
                paymentTerm: "in_advance",
              },
            }
          : card,
      ),
    });
  }
  phases.push({
    key: "default",
    name: "Default",
    duration: null,
    rateCards,
  });

  return {
    key: planKey,
    name: planName,
    currency,
    billingCadence: "P1M",
    phases,
    metadata: {
      pymthouse_client_id: input.clientId,
      pymthouse_plan_id: plan.id,
      meter_slug: NETWORK_FEE_USD_MICROS_METER,
    },
  };
}

export type OpenMeterPlanView = {
  id: string;
  key: string;
  status: string;
};

const OPENMETER_PLAN_USABLE_STATUSES = new Set(["active", "scheduled"]);

export async function verifyOpenMeterPlanId(
  client: OpenMeter,
  planId: string,
): Promise<OpenMeterPlanView | null> {
  try {
    const plan = await client.plans.get(planId);
    if (!plan?.id) {
      return null;
    }
    if (!OPENMETER_PLAN_USABLE_STATUSES.has(plan.status)) {
      return null;
    }
    return {
      id: plan.id,
      key: plan.key,
      status: plan.status,
    };
  } catch (err) {
    if (isOpenMeterPlanNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

export async function syncPlanToOpenMeter(planId: string): Promise<{
  ok: boolean;
  openmeterPlanId?: string;
  openmeterPlanVersion?: number | null;
  republished?: boolean;
  error?: string;
  message?: string;
}> {
  const planRows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  const plan = planRows[0];
  if (plan?.status !== "active") {
    return { ok: false, error: "Plan not active" };
  }

  if (!(await isBillingClientAvailableForApp(plan.clientId))) {
    return {
      ok: false,
      error: "OpenMeter is not configured (set OPENMETER_URL; OPENMETER_API_KEY only for secured deployments)",
    };
  }

  const client = await getBillingClientForApp(plan.clientId);
  const capabilityRows = await db
    .select()
    .from(planCapabilityBundles)
    .where(
      and(
        eq(planCapabilityBundles.planId, planId),
        eq(planCapabilityBundles.clientId, plan.clientId),
      ),
    );

  const omPlan = await mapPymthousePlanToOpenMeterCreate({
    clientId: plan.clientId,
    plan,
    capabilities: capabilityRows,
    client,
  });
  if (!omPlan) {
    await db
      .update(plans)
      .set({
        lastSyncedAt: new Date().toISOString(),
        syncError: null,
      })
      .where(eq(plans.id, planId));
    return { ok: true };
  }

  const now = new Date().toISOString();
  let republished = false;

  try {
    let openmeterPlanId = plan.openmeterPlanId ?? undefined;
    let version = plan.openmeterPlanVersion ?? undefined;

    if (openmeterPlanId) {
      try {
        const updated = await client.plans.update(
          openmeterPlanId,
          omPlan as unknown as Parameters<typeof client.plans.update>[1],
        );
        openmeterPlanId = updated?.id ?? openmeterPlanId;
        version = updated?.version ?? version;
      } catch (updateErr) {
        if (isOpenMeterPlanImmutableError(updateErr)) {
          // Published plans are immutable: create a new version under the same key.
          republished = true;
          openmeterPlanId = undefined;
          version = undefined;
        } else if (isOpenMeterPlanNotFoundError(updateErr)) {
          openmeterPlanId = undefined;
          version = undefined;
        } else {
          throw updateErr;
        }
      }
    }

    if (!openmeterPlanId) {
      const created = await client.plans.create(
        omPlan as unknown as Parameters<typeof client.plans.create>[0],
      );
      openmeterPlanId = created?.id;
      version = created?.version;
      if (republished) {
        // Keep republished=true so callers can migrate subscriptions to the new version.
      }
    }

    if (!openmeterPlanId) {
      throw new Error("OpenMeter plan create/update returned no id");
    }

    const published = await client.plans.publish(openmeterPlanId);
    version = published?.version ?? version;

    await db
      .update(plans)
      .set({
        openmeterPlanId,
        openmeterPlanVersion: version ?? null,
        lastSyncedAt: now,
        syncError: null,
      })
      .where(eq(plans.id, planId));

    return {
      ok: true,
      openmeterPlanId,
      openmeterPlanVersion: version ?? null,
      republished,
      message: republished
        ? "Published plan was immutable; created and published a new OpenMeter plan version. Migrate active subscriptions to pick up the new version."
        : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(plans)
      .set({
        syncError: message,
        lastSyncedAt: now,
      })
      .where(eq(plans.id, planId));
    return { ok: false, error: message };
  }
}

export async function archivePlanInOpenMeter(planId: string): Promise<void> {
  const planRows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  const plan = planRows[0];
  if (!plan?.openmeterPlanId) {
    return;
  }
  const client = getHostedAdminClient();
  await client.plans.archive(plan.openmeterPlanId);
}
