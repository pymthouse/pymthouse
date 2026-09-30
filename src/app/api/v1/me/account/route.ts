import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import {
  canPurgeAccountRow,
  loadAccountDeletionEligibility,
  purgeEmptyAccountUser,
} from "@/lib/account-deletion";
import { authOptions } from "@/lib/next-auth-options";

export async function DELETE() {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = typeof sessionUser?.id === "string" ? sessionUser.id : undefined;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eligibility = await loadAccountDeletionEligibility(userId);
  if (!canPurgeAccountRow(eligibility.ownsApps)) {
    console.info("account deletion handed off; row owns apps", {
      userId,
      appCount: eligibility.appCount,
    });
    return NextResponse.json({
      deleted: false,
      handedOff: true,
      appCount: eligibility.appCount,
    });
  }

  await purgeEmptyAccountUser(userId);
  return NextResponse.json({ deleted: true, handedOff: false });
}
