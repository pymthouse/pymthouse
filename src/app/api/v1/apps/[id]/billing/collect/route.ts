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
 * POST /api/v1/apps/{clientId}/billing/collect — ask settlement to raise an
 * invoice for a subject's unbilled usage now instead of waiting for the
 * amount-based trigger or OpenMeter's daily collection.
 *
 * `outcome: "queued"` means settlement accepted the request onto its
 * per-customer Kafka lane, not that an invoice exists yet — the raise itself
 * happens asynchronously there, which is also what serializes it against any
 * other raise already in flight for the same customer instead of racing one.
 * Poll `billingState` (already returned alongside it) or billing history to
 * see the result land.
 *
 * HTTP status: `queued` / `skipped` / `rate_limited` → 200; settlement not
 * configured → 503 (`unavailable`); settlement rejected/failed → 502 (`error`).
 *
 * Idempotent within the trigger cooldown: repeat calls return `rate_limited`
 * with the current state rather than queuing duplicate raises. Debt below
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

  const status =
    result.outcome === "error"
      ? 502
      : result.outcome === "unavailable"
        ? 503
        : 200;

  return NextResponse.json(
    {
      outcome: result.outcome,
      invoiceIds: result.invoiceIds,
      billingState: state,
    },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
