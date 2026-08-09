import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import {
  readConfirmFlag,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
import { tryDecodeURIComponent } from "@/lib/billing-utils";
import {
  AppUserSubscriptionCancelError,
  appUserSubscriptionCancelHttpStatus,
  cancelAppUserSubscription,
  resolveAppUserPendingCancel,
} from "@/lib/openmeter/app-user-subscription-lifecycle";
import {
  buildAppUserSubscriptionPlanPayload,
  resolveAppUserSubscriptionActionRequired,
  resolveAppUserSubscriptionPlanName,
} from "@/lib/billing/app-user-subscription-display";
import { isOwnerStarterPlanKey } from "@/lib/openmeter/owner-starter-key";
import {
  getPendingOpenMeterSubscriptionForAppUser,
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
} from "@/lib/openmeter/subscription-read";
import { includedDiscountUsdMicrosForPlan } from "@/lib/openmeter/spendable-allowance";
import { formatUsdMicrosForDisplay } from "@/lib/billing/pay-per-use-threshold";

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
  const includedMicros = plan
    ? includedDiscountUsdMicrosForPlan(plan)
    : isOwnerStarter
      ? includedDiscountUsdMicrosForPlan({
          includedUsdMicros: null,
          isStarterDefault: true,
        })
      : null;
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
 * GET /api/v1/apps/{clientId}/users/{externalUserId}/subscription
 *
 * Current OpenMeter subscription for an app end-user, including
 * `pendingCancel` when cancel-at-period-end is scheduled (owner-paid parity).
 * Also exposes `livePlan` / `pendingPlan` so scheduled successors are visible
 * when Neon cache and the dashboard would otherwise disagree.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = tryDecodeURIComponent(raw)?.trim() ?? "";
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required" },
      { status: 400 },
    );
  }
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [omSubscription, pendingOm] = await Promise.all([
    getPrimaryOpenMeterSubscriptionForAppUser({
      clientId: access.app.id,
      externalUserId,
    }),
    getPendingOpenMeterSubscriptionForAppUser({
      clientId: access.app.id,
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
      clientId: access.app.id,
      subscription: omSubscription,
    });
  } catch (err) {
    console.error("Failed to resolve pendingCancel for app user", err);
  }

  const resolvedPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    access.app.id,
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
    buildPlanSurface({ appId: access.app.id, subscription: omSubscription }),
    pendingOm
      ? buildPlanSurface({ appId: access.app.id, subscription: pendingOm })
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
      // Owner Starter is a platform plan (no Neon row); match local Starter typing.
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

/**
 * DELETE /api/v1/apps/{clientId}/users/{externalUserId}/subscription
 *
 * Schedule cancel at next billing cycle (owner-paid parity).
 * Body: `{ confirm: true }`.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = tryDecodeURIComponent(raw)?.trim() ?? "";
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required" },
      { status: 400 },
    );
  }
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObject(request);

  try {
    const result = await cancelAppUserSubscription({
      clientId: access.app.id,
      externalUserId,
      confirm: readConfirmFlag(body),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AppUserSubscriptionCancelError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: appUserSubscriptionCancelHttpStatus(err.code) },
      );
    }
    console.error("App-user subscription cancel failed", err);
    return NextResponse.json(
      { error: "Subscription cancel failed", code: "cancel_failed" },
      { status: 502 },
    );
  }
}
