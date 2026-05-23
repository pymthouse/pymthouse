import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, hasScope } from "@/lib/auth";
import { fetchPaymentDaemonStatus } from "@/lib/payment-daemon-status";

/**
 * GET /api/v1/payment/status
 *
 * Live state from the LPNM payment-daemon PayerDaemon gRPC service over the
 * unix socket. Admin-only.
 */
export async function GET(request: NextRequest) {
  const admin = await getAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await fetchPaymentDaemonStatus();
  return NextResponse.json(status);
}

async function getAdminUser(request: NextRequest) {
  const oauthSession = await getServerSession(authOptions);
  if (oauthSession?.user) {
    const sessionUser = oauthSession.user as Record<string, unknown>;
    if (sessionUser.id) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, sessionUser.id as string))
        .limit(1);
      const user = rows[0];
      if (user?.role !== "admin") return null;
      return user;
    }
  }

  const auth = await authenticateRequest(request);
  if (auth && hasScope(auth.scopes, "admin") && auth.userId) {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);
    const user = rows[0];
    if (user?.role !== "admin") return null;
    return user;
  }

  return null;
}
