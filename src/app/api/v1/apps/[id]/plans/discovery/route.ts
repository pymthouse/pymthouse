import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/index";
import { planCapabilityBundles, plans } from "@/db/schema";
import { authenticateAppClient } from "@/lib/auth";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import { discoveryPolicyFromDb } from "@/lib/discovery-plans";

async function resolveAppForPlansRead(clientId: string, request: NextRequest) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const app = await getProviderApp(clientId);
    return app;
  }
  const auth = await getAuthorizedProviderApp(clientId);
  return auth?.app ?? null;
}

/**
 * App-scoped discovery policy for integrators (e.g. NaaP).
 * Read-only; M2M Basic auth or provider dashboard session.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveAppForPlansRead(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.clientId, app.id), eq(plans.status, "active")));

  const bundles = await db
    .select()
    .from(planCapabilityBundles)
    .where(eq(planCapabilityBundles.clientId, app.id));

  return NextResponse.json({
    plans: rows.map((plan) => ({
      id: plan.id,
      name: plan.name,
      status: plan.status,
      discoveryPolicy: discoveryPolicyFromDb(plan.discoveryPolicy),
      capabilities: bundles
        .filter((b) => b.planId === plan.id)
        .map((b) => ({
          pipeline: b.pipeline,
          modelId: b.modelId,
          discoveryPolicy: discoveryPolicyFromDb(b.discoveryPolicy),
        })),
    })),
  });
}
