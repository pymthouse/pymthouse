import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { syncBillingProduct } from "@/lib/billing/backend";
import {
  canEditProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; planId: string }> },
) {
  const { id: clientId, planId } = await params;

  const auth = await getAuthorizedProviderApp(clientId, request);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const planRows = await db
    .select({ id: plans.id, clientId: plans.clientId })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  const plan = planRows[0];
  if (!plan || plan.clientId !== auth.app.id) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  let result;
  try {
    result = await syncBillingProduct(planId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        planId,
        ok: false,
        error: message,
        sync: {
          status: "error",
          syncedAt: null,
          errorCode: "sync_failed",
          errorMessage: message,
        },
      },
      { status: 422 },
    );
  }
  if (!result.ok) {
    return NextResponse.json(
      {
        planId,
        ok: false,
        sync: result.sync,
        openmeterPlanId: result.openmeterPlanId ?? null,
        error: result.sync.errorMessage ?? "Sync failed",
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    planId,
    ok: true,
    sync: result.sync,
    openmeterPlanId: result.openmeterPlanId ?? null,
  });
}
