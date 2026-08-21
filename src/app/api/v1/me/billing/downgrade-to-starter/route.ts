import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  OwnerStarterDowngradeError,
  downgradeOwnerToStarterPlan,
  ownerStarterDowngradeHttpStatus,
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
 * Schedule Sandbox Starter for the signed-in owner at end of the current cycle.
 * Body: `{ confirm: true }`. Keeps the active Owner Paid plan until then.
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
    const result = await downgradeOwnerToStarterPlan({
      ownerUserId: userId,
      confirm: body.confirm === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OwnerStarterDowngradeError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: ownerStarterDowngradeHttpStatus(err.code) },
      );
    }
    console.error("Owner Starter downgrade failed", err);
    return NextResponse.json(
      { error: "Owner Starter downgrade failed", code: "downgrade_failed" },
      { status: 502 },
    );
  }
}
