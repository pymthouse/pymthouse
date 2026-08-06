import { NextRequest, NextResponse } from "next/server";

import {
  authorizeOwnerBillingM2m,
  readConfirmFlag,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
import { getOwnerSubscriptionSwitchingStatus } from "@/lib/billing/owner-billing-m2m-status";
import {
  OwnerPaidUpgradeError,
  upgradeOwnerToPaidPlan,
} from "@/lib/openmeter/owner-paid-plan";
import { ownerPaidUpgradeHttpStatus } from "@/lib/openmeter/owner-paid-upgrade-status";
import {
  OwnerStarterDowngradeError,
  downgradeOwnerToStarterPlan,
  ownerStarterDowngradeHttpStatus,
} from "@/lib/openmeter/owner-starter-downgrade";

/**
 * GET /api/v1/apps/{clientId}/billing/subscription
 *
 * Current owner-wallet plan, pending Starter downgrade, and payment-method
 * readiness for M2M integrators. Auth: M2M Basic only.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const auth = await authorizeOwnerBillingM2m(request, clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const status = await getOwnerSubscriptionSwitchingStatus(auth.ownerUserId);
    return NextResponse.json(status);
  } catch (err) {
    console.error("Owner subscription status failed", err);
    return NextResponse.json(
      { error: "Failed to load owner subscription status" },
      { status: 502 },
    );
  }
}

/**
 * PUT /api/v1/apps/{clientId}/billing/subscription
 *
 * Upgrade / change the app owner's Owner Paid tier.
 * Body: `{ planKey, confirm: true }`. Auth: M2M Basic only.
 */
export async function PUT(
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

/**
 * DELETE /api/v1/apps/{clientId}/billing/subscription
 *
 * Schedule Sandbox Starter at end of cycle for the app owner wallet.
 * Body: `{ confirm: true }`. Auth: M2M Basic only.
 */
export async function DELETE(
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
