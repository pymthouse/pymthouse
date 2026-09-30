import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { loadAccountDeletionEligibility } from "@/lib/account-deletion";
import { authOptions } from "@/lib/next-auth-options";

export async function GET() {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = typeof sessionUser?.id === "string" ? sessionUser.id : undefined;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eligibility = await loadAccountDeletionEligibility(userId);
  return NextResponse.json(eligibility);
}
