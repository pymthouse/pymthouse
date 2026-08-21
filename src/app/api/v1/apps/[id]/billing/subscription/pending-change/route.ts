import { NextRequest, NextResponse } from "next/server";

import {
  authorizeOwnerBillingM2m,
  readConfirmFlag,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
import {
  OwnerPaidResumeError,
  ownerPaidResumeHttpStatus,
  resumeOwnerPaidAfterScheduledDowngrade,
} from "@/lib/openmeter/owner-starter-downgrade";

/**
 * DELETE /api/v1/apps/{clientId}/billing/subscription/pending-change
 *
 * Cancel a scheduled Sandbox Starter downgrade for the app owner wallet.
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
    const result = await resumeOwnerPaidAfterScheduledDowngrade({
      ownerUserId: auth.ownerUserId,
      confirm: readConfirmFlag(body),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OwnerPaidResumeError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: ownerPaidResumeHttpStatus(err.code) },
      );
    }
    console.error("Owner Paid resume (M2M) failed", err);
    return NextResponse.json(
      { error: "Owner Paid resume failed", code: "resume_failed" },
      { status: 502 },
    );
  }
}
