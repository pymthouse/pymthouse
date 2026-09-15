import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import {
  buildAppUserSubscriptionPlanPayload,
  resolveAppUserSubscriptionActionRequired,
  resolveAppUserSubscriptionPlanName,
} from "@/lib/billing/app-user-subscription-display";
import { formatUsdMicrosForDisplay } from "@/lib/billing/pay-per-use-threshold";
import { resolveAppUserPendingCancel } from "@/lib/openmeter/app-user-subscription-lifecycle";
import { isOwnerStarterPlanKey } from "@/lib/openmeter/owner-starter-key";
import { includedDiscountUsdMicrosForPlan } from "@/lib/openmeter/spendable-allowance";
import {
  getPendingOpenMeterSubscriptionForAppUser,
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
} from "@/lib/openmeter/subscription-read";

type PlanSurface = {
  id: string | null;
  name: string | null;
  type: string | null;
  includedUsage: {
    usdMicros: string;
    usd: string;
  } | null;
  effectiveAt: string | null;
};

async function buildPlanSurface(input: {
  appId: string;
  subscription: NonNullable<
    Awaited<ReturnType<typeof getPrimaryOpenMeterSubscriptionForAppUser>>
  >;
}): Promise<PlanSurface> {
  const resolvedPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    input.appId,
    input.subscription,
  );
  const planRows = resolvedPlanId
    ? await db.select().from(plans).where(eq(plans.id, resolvedPlanId)).limit(1)
    : [];
  const plan = planRows[0] ?? null;
  const isOwnerStarter = isOwnerStarterPlanKey(input.subscription.planKey);
  const planName = resolveAppUserSubscriptionPlanName({
    plan,
    planKey: input.subscription.planKey,
  });
  let includedMicros: bigint | null = null;
  if (plan) {
    includedMicros = includedDiscountUsdMicrosForPlan(plan);
  } else if (isOwnerStarter) {
    includedMicros = includedDiscountUsdMicrosForPlan({
      includedUsdMicros: null,
      isStarterDefault: true,
    });
  }
  return {
    id: plan?.id ?? null,
    name: planName,
    type: plan?.type ?? (isOwnerStarter ? "free" : null),
    includedUsage:
      includedMicros != null
        ? {
            usdMicros: includedMicros.toString(),
            usd: formatUsdMicrosForDisplay(includedMicros.toString()),
          }
        : null,
    effectiveAt: input.subscription.activeFrom,
  };
}

/**
 * Current OpenMeter subscription for an app end-user, including
 * `pendingCancel` and `livePlan` / `pendingPlan`.
 */
export async function loadAppUserSubscriptionView(input: {
  appId: string;
  externalUserId: string;
}): Promise<Response> {
  const { appId, externalUserId } = input;

  const [omSubscription, pendingOm] = await Promise.all([
    getPrimaryOpenMeterSubscriptionForAppUser({
      clientId: appId,
      externalUserId,
    }),
    getPendingOpenMeterSubscriptionForAppUser({
      clientId: appId,
      externalUserId,
    }),
  ]);

  if (!omSubscription) {
    return NextResponse.json({
      externalUserId,
      subscription: null,
      pendingCancel: null,
      livePlan: null,
      pendingPlan: null,
      source: "openmeter",
    });
  }

  let pendingCancel: Awaited<ReturnType<typeof resolveAppUserPendingCancel>> =
    null;
  try {
    pendingCancel = await resolveAppUserPendingCancel({
      clientId: appId,
      subscription: omSubscription,
    });
  } catch (err) {
    console.error("Failed to resolve pendingCancel for app user", err);
  }

  const resolvedPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    appId,
    omSubscription,
  );
  const planRows = resolvedPlanId
    ? await db.select().from(plans).where(eq(plans.id, resolvedPlanId)).limit(1)
    : [];
  const plan = planRows[0] ?? null;
  const isOwnerStarter = isOwnerStarterPlanKey(omSubscription.planKey);
  const planName = resolveAppUserSubscriptionPlanName({
    plan,
    planKey: omSubscription.planKey,
  });
  const actionRequired = resolveAppUserSubscriptionActionRequired({
    plan,
    isOwnerStarter,
  });
  const planPayload = buildAppUserSubscriptionPlanPayload({
    plan,
    isOwnerStarter,
  });

  const [livePlan, pendingPlan] = await Promise.all([
    buildPlanSurface({ appId, subscription: omSubscription }),
    pendingOm
      ? buildPlanSurface({ appId, subscription: pendingOm })
      : Promise.resolve(null),
  ]);

  return NextResponse.json({
    externalUserId,
    source: "openmeter",
    actionRequired,
    plan: planPayload,
    pendingCancel,
    livePlan,
    pendingPlan,
    subscription: {
      id: omSubscription.id,
      status: omSubscription.status,
      planId: plan?.id ?? null,
      planName,
      planType: plan?.type ?? (isOwnerStarter ? "free" : null),
      openmeterPlanKey: omSubscription.planKey,
      currentPeriodStart: omSubscription.activeFrom,
      currentPeriodEnd: omSubscription.activeTo,
      openmeterSubscriptionId: omSubscription.id,
      stripeCheckoutSessionId: null,
      createdAt: null,
      cancelledAt: null,
    },
  });
}
