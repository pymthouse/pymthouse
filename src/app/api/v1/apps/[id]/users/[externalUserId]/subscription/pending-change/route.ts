import { NextRequest, NextResponse } from "next/server";

import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import {
  readConfirmFlag,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
import {
  AppUserSubscriptionResumeError,
  appUserSubscriptionResumeHttpStatus,
  resumeAppUserSubscription,
} from "@/lib/openmeter/app-user-subscription-lifecycle";

/**
 * DELETE /api/v1/apps/{clientId}/users/{externalUserId}/subscription/pending-change
 *
 * Undo a scheduled end-of-cycle cancel (owner-paid resume parity).
 * Body: `{ confirm: true }`.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = decodeURIComponent(raw);
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObject(request);

  try {
    const result = await resumeAppUserSubscription({
      clientId: access.app.id,
      externalUserId,
      confirm: readConfirmFlag(body),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AppUserSubscriptionResumeError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: appUserSubscriptionResumeHttpStatus(err.code) },
      );
    }
    console.error("App-user subscription resume failed", err);
    return NextResponse.json(
      { error: "Subscription resume failed", code: "resume_failed" },
      { status: 502 },
    );
  }
}
