import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
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

  return NextResponse.json({
    externalUserId,
    source: "openmeter",
    subscription: {
      id: omSubscription.id,
      status: omSubscription.status,
      planId: plan?.id ?? null,
      planName: plan?.name ?? null,
      planType: plan?.type ?? null,
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
