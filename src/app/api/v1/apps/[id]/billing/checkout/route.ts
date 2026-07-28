import { NextRequest, NextResponse } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import { runActivationGate } from "@/lib/activation/app-activation";
import { activationErrorResponse } from "@/lib/activation/problem";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import { createEndUserCheckout } from "@/lib/openmeter/subscriptions-billing";

async function resolveCheckoutApp(clientId: string, request: NextRequest) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    return getProviderApp(clientId);
  }
  try {
    const providerAuth = await getAuthorizedProviderApp(clientId, request);
    return providerAuth?.app ?? null;
  } catch {
    return null;
  }
}

function readCheckoutBody(body: Record<string, unknown>): {
  planId: string;
  externalUserId: string;
  successUrl?: string;
  cancelUrl?: string;
} | null {
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const externalUserId =
    typeof body.externalUserId === "string" ? body.externalUserId.trim() : "";
  if (!planId || !externalUserId) {
    return null;
  }
  return {
    planId,
    externalUserId,
    successUrl: typeof body.successUrl === "string" ? body.successUrl : undefined,
    cancelUrl: typeof body.cancelUrl === "string" ? body.cancelUrl : undefined,
  };
}

async function runSellGate(appId: string): Promise<NextResponse | null> {
  try {
    await runActivationGate("sell_paid_plans", appId);
    return null;
  } catch (err) {
    const problem = activationErrorResponse(err);
    if (problem) return problem;
    throw err;
  }
}

async function createCheckoutOrError(
  appId: string,
  fields: NonNullable<ReturnType<typeof readCheckoutBody>>,
): Promise<NextResponse> {
  try {
    const result = await createEndUserCheckout({
      clientId: appId,
      externalUserId: fields.externalUserId,
      planId: fields.planId,
      successUrl: fields.successUrl,
      cancelUrl: fields.cancelUrl,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveCheckoutApp(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fields = readCheckoutBody(body);
  if (!fields) {
    return NextResponse.json(
      { error: "planId and externalUserId are required" },
      { status: 400 },
    );
  }

  const gateProblem = await runSellGate(app.id);
  if (gateProblem) {
    return gateProblem;
  }

  return createCheckoutOrError(app.id, fields);
}
