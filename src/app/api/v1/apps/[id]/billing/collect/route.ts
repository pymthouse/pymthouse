import { NextRequest, NextResponse } from "next/server";

import { loadBillingState } from "@/lib/billing/billing-state-read";
import { invoiceGatheringForIdentity } from "@/lib/billing/invoice-trigger";
import {
  authorizeOwnerWalletM2m,
  readJsonObjectBody,
} from "@/lib/billing/owner-wallet-m2m-auth";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";

/**
 * POST /api/v1/apps/{clientId}/billing/collect — raise an invoice for a
 * subject's unbilled usage now instead of waiting for the amount-based trigger
 * or OpenMeter's daily collection.
 *
 * Idempotent within the trigger cooldown: repeat calls return `rate_limited`
 * with the current state rather than raising duplicate invoices. Debt below
 * Stripe's minimum charge returns `skipped`, since such an invoice could never
 * be collected.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeOwnerWalletM2m(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObjectBody(request);
  const externalUserId = readOptionalExternalUserId(body.externalUserId);
  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId,
  });
  if (!billingTarget.ok) {
    return NextResponse.json(
      { error: billingTarget.error },
      { status: billingTarget.status },
    );
  }

  const subjectId =
    billingTarget.target.mode === "merchant"
      ? billingTarget.target.externalUserId
      : externalUserId;
  if (!subjectId) {
    return NextResponse.json(
      { error: "externalUserId is required to collect usage" },
      { status: 400 },
    );
  }

  const result = await invoiceGatheringForIdentity({
    clientId,
    externalUserId: subjectId,
    force: true,
  });

  const state = await loadBillingState({
    publicClientId: clientId,
    appId: access.app.id,
    target: billingTarget.target,
    externalUserId: subjectId,
  });

  return NextResponse.json(
    {
      outcome: result.outcome,
      invoiceIds: result.invoiceIds,
      billingState: state,
    },
    {
      status: result.outcome === "error" ? 502 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
