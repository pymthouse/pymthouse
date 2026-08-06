import { NextRequest, NextResponse } from "next/server";

import {
  authorizeOwnerBillingM2m,
  readConfirmFlag,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
import {
  OwnerStarterDowngradeError,
  downgradeOwnerToStarterPlan,
  ownerStarterDowngradeHttpStatus,
} from "@/lib/openmeter/owner-starter-downgrade";

/**
 * POST /api/v1/apps/{clientId}/billing/downgrade-to-starter
 *
 * Schedule Sandbox Starter at end of cycle for the app owner wallet.
 * Body: `{ confirm: true }`. Auth: M2M Basic only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await authorizeOwnerBillingM2m(request, clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObject(request);

  try {
    const result = await downgradeOwnerToStarterPlan({
      ownerUserId: auth.ownerUserId,
      confirm: readConfirmFlag(body),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OwnerStarterDowngradeError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: ownerStarterDowngradeHttpStatus(err.code) },
      );
    }
    console.error("Owner Starter downgrade (M2M) failed", err);
    return NextResponse.json(
      { error: "Owner Starter downgrade failed", code: "downgrade_failed" },
      { status: 502 },
    );
  }
}
