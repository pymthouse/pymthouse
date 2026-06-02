import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { apiKeys, planCapabilityBundles, plans, subscriptions } from "@/db/schema";
import { hashToken } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const keyHash = hashToken(token);
  const apiKeyRows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  const apiKey = apiKeyRows[0];
  if (!apiKey || apiKey.status !== "active") {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  if (!apiKey.subscriptionId) {
    return NextResponse.json({
      valid: true,
      client_id: apiKey.clientId,
      plan: null,
      allowedModels: [],
    });
  }

  const subRows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, apiKey.subscriptionId),
        eq(subscriptions.clientId, apiKey.clientId),
      ),
    )
    .limit(1);
  const subscription = subRows[0];

  if (!subscription || subscription.status !== "active") {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, subscription.planId))
    .limit(1);
  const plan = planRows[0];
  if (!plan) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const capabilities = await db
    .select()
    .from(planCapabilityBundles)
    .where(eq(planCapabilityBundles.planId, plan.id));

  return NextResponse.json({
    valid: true,
    client_id: apiKey.clientId,
    plan: {
      ...plan,
      includedUnits: plan.includedUnits != null ? plan.includedUnits.toString() : null,
      overageRateUsd: plan.overageRateUsd ?? null,
    },
    allowedModels: capabilities.map((bundle) => bundle.modelId).filter(Boolean),
  });
}
