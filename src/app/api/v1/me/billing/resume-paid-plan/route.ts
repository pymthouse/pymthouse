import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  OwnerPaidResumeError,
  ownerPaidResumeHttpStatus,
  resumeOwnerPaidAfterScheduledDowngrade,
} from "@/lib/openmeter/owner-starter-downgrade";

function sessionUserId(session: unknown): string | undefined {
  if (!session || typeof session !== "object") {
    return undefined;
  }
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") {
    return undefined;
  }
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Cancel a scheduled Sandbox Starter downgrade for the signed-in owner.
 * Body: `{ confirm: true }`. Restores the active Owner Paid subscription;
 * does not charge.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = sessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { confirm?: unknown } = {};
  try {
    body = (await req.json()) as { confirm?: unknown };
  } catch {
    body = {};
  }

  try {
    const result = await resumeOwnerPaidAfterScheduledDowngrade({
      ownerUserId: userId,
      confirm: body.confirm === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OwnerPaidResumeError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: ownerPaidResumeHttpStatus(err.code) },
      );
    }
    console.error("Owner Paid resume failed", err);
    return NextResponse.json(
      { error: "Owner Paid resume failed", code: "resume_failed" },
      { status: 502 },
    );
  }
}
