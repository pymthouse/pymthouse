import { NextRequest, NextResponse } from "next/server";

import {
  authorizeOwnerBillingM2m,
  readConfirmFlag,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
import {
  OwnerPaidUpgradeError,
  upgradeOwnerToPaidPlan,
} from "@/lib/openmeter/owner-paid-plan";
import { ownerPaidUpgradeHttpStatus } from "@/lib/openmeter/owner-paid-upgrade-status";

/**
 * POST /api/v1/apps/{clientId}/billing/upgrade-paid
 *
 * Upgrade / change the app owner's Owner Paid tier.
 * Body: `{ planKey, confirm: true }`. Auth: M2M Basic only.
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
  const planKey =
    typeof body.planKey === "string" ? body.planKey.trim() : undefined;

  try {
    const result = await upgradeOwnerToPaidPlan({
      ownerUserId: auth.ownerUserId,
      planKey,
      confirm: readConfirmFlag(body),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OwnerPaidUpgradeError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: ownerPaidUpgradeHttpStatus(err.code) },
      );
    }
    console.error("Owner Paid upgrade (M2M) failed", err);
    return NextResponse.json(
      { error: "Owner Paid upgrade failed", code: "upgrade_failed" },
      { status: 502 },
    );
  }
}
