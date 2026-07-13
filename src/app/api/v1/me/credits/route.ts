import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/next-auth-options";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";

/**
 * Lightweight owner prepaid credit summary for the dashboard sidebar.
 * Single Konnect customer lookup (`owner:{users.id}`) — not an end-user sum.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = typeof sessionUser?.id === "string" ? sessionUser.id : undefined;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const creditAllowance = await getOwnerPrepaidCreditBalance(userId);
  if (!creditAllowance) {
    return NextResponse.json({ creditAllowance: null });
  }

  return NextResponse.json({ creditAllowance });
}
