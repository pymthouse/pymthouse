import { NextRequest, NextResponse } from "next/server";
import {
  readActiveDiscoveryPlans,
  resolveReadablePlansApp,
} from "@/domains/plans-discovery/runtime/plans-read";

/**
 * App-scoped discovery policy for integrators (e.g. NaaP).
 * Read-only; M2M Basic auth or provider dashboard session.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveReadablePlansApp(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ plans: await readActiveDiscoveryPlans(app.id) });
}
