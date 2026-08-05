import { NextResponse } from "next/server";

import {
  listSelectableOwnerSubscriptionTiers,
  toOwnerSubscriptionTierPublic,
} from "@/lib/billing/owner-subscription-tiers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";

function sessionUserId(session: unknown): string | undefined {
  if (!session || typeof session !== "object") return undefined;
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") return undefined;
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/** List selectable Owner Paid tiers for the Upgrade picker. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!sessionUserId(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tiers = await listSelectableOwnerSubscriptionTiers();
  return NextResponse.json({
    tiers: tiers.map(toOwnerSubscriptionTierPublic),
  });
}
