import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import {
  OwnerPaidUpgradeError,
  upgradeOwnerToPaidPlan,
} from "@/lib/openmeter/owner-paid-plan";

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
 * Upgrade the signed-in owner from Sandbox Starter → Owner Paid.
 * Requires a chargeable payment method (Add payment method first).
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  const userId = sessionUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await upgradeOwnerToPaidPlan({ ownerUserId: userId });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OwnerPaidUpgradeError) {
      const status =
        err.code === "payment_method_required"
          ? 402
          : err.code === "openmeter_unavailable"
            ? 503
            : err.code === "no_subscription"
              ? 404
              : 400;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
