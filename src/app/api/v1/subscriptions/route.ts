import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { subscriptions } from "@/db/schema";
import {
  deprecatedLocalSubscriptionMutationResponse,
  LOCAL_SUBSCRIPTION_DEPRECATION_HEADERS,
} from "@/lib/deprecated-local-subscription-api";

async function getSessionUserId() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined;
  return userId ?? null;
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));

  return NextResponse.json(
    {
      subscriptions: rows,
      deprecation:
        "Local subscription rows are cache-only. OpenMeter/Konnect is authoritative for active billing state.",
    },
    { headers: LOCAL_SUBSCRIPTION_DEPRECATION_HEADERS },
  );
}

export async function POST(_request: NextRequest) {
  return deprecatedLocalSubscriptionMutationResponse();
}

export async function DELETE(_request: NextRequest) {
  return deprecatedLocalSubscriptionMutationResponse();
}
