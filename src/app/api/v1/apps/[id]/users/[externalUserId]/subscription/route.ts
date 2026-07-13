import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import {
  cancelEndUserSubscription,
  changeEndUserSubscription,
  migrateEndUserSubscriptionToLatestPlanVersion,
  type SubscriptionTimingMode,
} from "@/lib/openmeter/subscriptions-billing";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
} from "@/lib/openmeter/subscription-read";

function parseTiming(raw: unknown): SubscriptionTimingMode | undefined {
  if (raw === "immediate" || raw === "next_billing_cycle") {
    return raw;
  }
  return undefined;
}

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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = decodeURIComponent(raw);
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action.trim() : "change";
  const timing = parseTiming(body.timing);

  try {
    if (action === "migrate") {
      const result = await migrateEndUserSubscriptionToLatestPlanVersion({
        clientId: access.app.id,
        externalUserId,
        timing,
      });
      return NextResponse.json({ externalUserId, ...result });
    }

    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    if (!planId) {
      return NextResponse.json({ error: "planId is required" }, { status: 400 });
    }

    const result = await changeEndUserSubscription({
      clientId: access.app.id,
      externalUserId,
      planId,
      timing,
    });
    return NextResponse.json({ externalUserId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = decodeURIComponent(raw);
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let timing: SubscriptionTimingMode | undefined;
  try {
    const body = await request.json();
    timing = parseTiming(body?.timing);
  } catch {
    timing = undefined;
  }

  try {
    const result = await cancelEndUserSubscription({
      clientId: access.app.id,
      externalUserId,
      timing,
    });
    return NextResponse.json({ externalUserId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
