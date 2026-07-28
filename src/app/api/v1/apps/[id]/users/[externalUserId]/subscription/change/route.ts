import { NextRequest, NextResponse } from "next/server";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
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
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
