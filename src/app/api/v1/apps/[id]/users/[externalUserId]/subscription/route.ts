import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans, subscriptions } from "@/db/schema";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";

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

  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clientId, access.app.id),
        eq(subscriptions.externalUserId, externalUserId),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  const sub = rows[0];
  if (!sub) {
    return NextResponse.json({
      externalUserId,
      subscription: null,
    });
  }

  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, sub.planId))
    .limit(1);
  const plan = planRows[0] ?? null;

  return NextResponse.json({
    externalUserId,
    subscription: {
      id: sub.id,
      status: sub.status,
      planId: sub.planId,
      planName: plan?.name ?? null,
      planType: plan?.type ?? null,
      currentPeriodStart: sub.currentPeriodStart ?? null,
      currentPeriodEnd: sub.currentPeriodEnd ?? null,
      openmeterSubscriptionId: sub.openmeterSubscriptionId ?? null,
      stripeCheckoutSessionId: sub.stripeCheckoutSessionId ?? null,
      createdAt: sub.createdAt,
      cancelledAt: sub.cancelledAt ?? null,
    },
  });
}
