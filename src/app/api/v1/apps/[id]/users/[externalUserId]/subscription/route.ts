import { NextRequest, NextResponse } from "next/server";

import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import { loadAppUserSubscriptionView } from "@/lib/billing/app-user-subscription-view";
import {
  readConfirmFlag,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
import { tryDecodeURIComponent } from "@/lib/billing-utils";
import {
  AppUserSubscriptionCancelError,
  appUserSubscriptionCancelHttpStatus,
  cancelAppUserSubscription,
} from "@/lib/openmeter/app-user-subscription-lifecycle";

/**
 * GET /api/v1/apps/{clientId}/users/{externalUserId}/subscription
 *
 * Current OpenMeter subscription for an app end-user, including
 * `pendingCancel` when cancel-at-period-end is scheduled (owner-paid parity).
 * Also exposes `livePlan` / `pendingPlan` so scheduled successors are visible
 * when Neon cache and the dashboard would otherwise disagree.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = tryDecodeURIComponent(raw)?.trim() ?? "";
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required" },
      { status: 400 },
    );
  }
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return loadAppUserSubscriptionView({
    appId: access.app.id,
    externalUserId,
  });
}

/**
 * DELETE /api/v1/apps/{clientId}/users/{externalUserId}/subscription
 *
 * Cancel paid plan. Body: `{ confirm: true, timing?: "immediate" | "next_billing_cycle" }`.
 * Default timing is end of cycle (owner-paid parity).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = tryDecodeURIComponent(raw)?.trim() ?? "";
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required" },
      { status: 400 },
    );
  }
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObject(request);

  let timing: "immediate" | "next_billing_cycle" | undefined;
  const rawTiming = body.timing;
  if (rawTiming !== undefined && rawTiming !== null && rawTiming !== "") {
    if (rawTiming !== "immediate" && rawTiming !== "next_billing_cycle") {
      return NextResponse.json(
        { error: 'timing must be "immediate" or "next_billing_cycle"' },
        { status: 400 },
      );
    }
    timing = rawTiming;
  }

  try {
    const result = await cancelAppUserSubscription({
      clientId: access.app.id,
      externalUserId,
      confirm: readConfirmFlag(body),
      timing,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AppUserSubscriptionCancelError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: appUserSubscriptionCancelHttpStatus(err.code) },
      );
    }
    console.error("App-user subscription cancel failed", err);
    return NextResponse.json(
      { error: "Subscription cancel failed", code: "cancel_failed" },
      { status: 502 },
    );
  }
}
