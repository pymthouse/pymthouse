import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import {
  planRequiresSellGate,
  runActivationGate,
} from "@/lib/activation/app-activation";
import { activationErrorResponse } from "@/lib/activation/problem";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import { AppUserOwnerWalletMutationError } from "@/lib/openmeter/billing-identity";
import { changeAppUserSubscriptionPlan } from "@/lib/openmeter/subscriptions-billing";
import type { SubscriptionChangeTiming } from "@/lib/openmeter/konnect-subscriptions";

function parseTiming(raw: unknown): SubscriptionChangeTiming | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (raw === "immediate" || raw === "next_billing_cycle") {
    return raw;
  }
  throw new Error('timing must be "immediate" or "next_billing_cycle"');
}

/**
 * Only priced targets need Connect. Free/starter switches and paid→free
 * migrations must stay reachable while the revenue rail is enforced, otherwise
 * an app phasing out a plan can never move its users off it. An unknown plan is
 * left to changeAppUserSubscriptionPlan, which reports it as "Plan not found".
 */
async function runSellGate(
  appId: string,
  planId: string,
): Promise<NextResponse | null> {
  const rows = await db
    .select({
      status: plans.status,
      priceAmount: plans.priceAmount,
      isStarterDefault: plans.isStarterDefault,
    })
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.clientId, appId)))
    .limit(1);
  const target = rows[0];
  if (!target || !planRequiresSellGate(target)) {
    return null;
  }

  try {
    await runActivationGate("sell_paid_plans", appId);
    return null;
  } catch (err) {
    const problem = activationErrorResponse(err);
    if (problem) return problem;
    throw err;
  }
}

function subscriptionChangeErrorResponse(err: unknown): NextResponse {
  if (err instanceof AppUserOwnerWalletMutationError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: 400 },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message === "User is already on this plan") {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (message.includes("OPENMETER_ROUTE_MODE") || message.includes("OPENMETER_URL")) {
    return NextResponse.json(
      { error: "Plan change is not available for this deployment" },
      { status: 503 },
    );
  }
  if (message.includes("Merchant Stripe Connect onboarding is required")) {
    return NextResponse.json(
      { error: "Merchant Stripe Connect onboarding is required before checkout" },
      { status: 403 },
    );
  }
  console.error("subscription change failed:", message);
  return NextResponse.json(
    { error: "Subscription change failed" },
    { status: 502 },
  );
}

export async function POST(
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

  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  let timing: SubscriptionChangeTiming | undefined;
  try {
    timing = parseTiming(body.timing);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid timing" },
      { status: 400 },
    );
  }

  const gateProblem = await runSellGate(access.app.id, planId);
  if (gateProblem) {
    return gateProblem;
  }

  try {
    const result = await changeAppUserSubscriptionPlan({
      clientId: access.app.id,
      externalUserId,
      planId,
      timing,
      successUrl:
        typeof body.successUrl === "string" ? body.successUrl : undefined,
      cancelUrl: typeof body.cancelUrl === "string" ? body.cancelUrl : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return subscriptionChangeErrorResponse(err);
  }
}
