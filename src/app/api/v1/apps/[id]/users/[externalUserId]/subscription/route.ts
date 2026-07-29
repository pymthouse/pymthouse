import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import {
  OWNER_STARTER_PLAN_NAME,
  isOwnerStarterPlanKey,
} from "@/lib/openmeter/owner-starter-key";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
} from "@/lib/openmeter/subscription-read";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = decodeURIComponent(raw);
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const omSubscription = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: access.app.id,
    externalUserId,
  });

  if (!omSubscription) {
    return NextResponse.json({
      externalUserId,
      subscription: null,
      source: "openmeter",
    });
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

  const planStatus = plan?.status ?? null;
  const actionRequired =
    (!plan && !isOwnerStarter) || planStatus === "phase_out"
      ? "choose_new_plan"
      : null;

  let planPayload: {
    id: string | null;
    status: string;
    phaseOutAt: string | null;
    replacementPlanId: string | null;
  };
  if (plan) {
    planPayload = {
      id: plan.id,
      status: plan.status,
      phaseOutAt: plan.phaseOutAt ?? null,
      replacementPlanId: plan.replacementPlanId ?? null,
    };
  } else if (isOwnerStarter) {
    planPayload = {
      id: null,
      status: "active",
      phaseOutAt: null,
      replacementPlanId: null,
    };
  } else {
    planPayload = {
      id: null,
      status: "missing",
      phaseOutAt: null,
      replacementPlanId: null,
    };
  }

  return NextResponse.json({
    externalUserId,
    source: "openmeter",
    actionRequired,
    plan: planPayload,
    subscription: {
      id: omSubscription.id,
      status: omSubscription.status,
      planId: plan?.id ?? null,
      planName: plan?.name ?? (isOwnerStarter ? OWNER_STARTER_PLAN_NAME : null),
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
