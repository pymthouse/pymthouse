import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plans-sync";
import { getOpenMeterSubscriptionForAppUser } from "@/lib/openmeter/subscription-read";

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

  const starter = await getOrCreateStarterPlan(access.app.id);
  const planKey = buildOpenMeterPlanKey(access.app.id, starter.id);
  const omSubscription = await getOpenMeterSubscriptionForAppUser({
    clientId: access.app.id,
    externalUserId,
    planKey,
  });

  if (!omSubscription) {
    return NextResponse.json({
      externalUserId,
      subscription: null,
      source: "openmeter",
    });
  }

  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, starter.id))
    .limit(1);
  const plan = planRows[0] ?? null;

  return NextResponse.json({
    externalUserId,
    source: "openmeter",
    subscription: {
      id: omSubscription.id,
      status: omSubscription.status,
      planId: starter.id,
      planName: plan?.name ?? null,
      planType: plan?.type ?? null,
      currentPeriodStart: omSubscription.activeFrom,
      currentPeriodEnd: omSubscription.activeTo,
      openmeterSubscriptionId: omSubscription.id,
      stripeCheckoutSessionId: null,
      createdAt: null,
      cancelledAt: null,
    },
  });
}
