import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  OwnerPaidUpgradeError,
  upgradeOwnerToPaidPlan,
} from "@/lib/openmeter/owner-paid-plan";
import { ownerPaidUpgradeHttpStatus } from "@/lib/openmeter/owner-paid-upgrade-status";

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
 * Upgrade the signed-in owner from Sandbox Starter → a selected Owner Paid tier.
 * Body: `{ planKey, confirm: true }`. Requires a chargeable payment method.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = sessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { planKey?: unknown; confirm?: unknown } = {};
  try {
    body = (await req.json()) as { planKey?: unknown; confirm?: unknown };
  } catch {
    body = {};
  }

  const planKey =
    typeof body.planKey === "string" ? body.planKey.trim() : undefined;
  const confirm = body.confirm === true;

  try {
    const result = await upgradeOwnerToPaidPlan({
      ownerUserId: userId,
      planKey,
      confirm,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OwnerPaidUpgradeError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: ownerPaidUpgradeHttpStatus(err.code) },
      );
    }
    console.error("Owner Paid upgrade failed", err);
    return NextResponse.json(
      { error: "Owner Paid upgrade failed", code: "upgrade_failed" },
      { status: 502 },
    );
  }
}
