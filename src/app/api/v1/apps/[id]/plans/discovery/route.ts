import { NextRequest, NextResponse } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";
import { resolvePlansDiscoveryForApp } from "@/lib/discovery-profile-resolve";

async function resolveAppForPlansRead(clientId: string, request: NextRequest) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const app = await getProviderApp(clientId);
    return app;
  }
  if (clientAuth) return null;

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

  const resolved = await resolvePlansDiscoveryForApp(app.id);
  const active = resolved.filter((r) => r.plan.status === "active");

  return NextResponse.json({
    plans: active.map((r) => ({
      id: r.plan.id,
      name: r.plan.name,
      status: r.plan.status,
      discoveryPolicy: r.discoveryPolicy,
      capabilities: r.capabilities.map((c) => ({
        pipeline: c.pipeline,
        modelId: c.modelId,
        discoveryPolicy: c.discoveryPolicy,
      })),
    })),
  });
}
