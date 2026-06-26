import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { eq } from "drizzle-orm";
import { authOptions } from "@/lib/next-auth-options";
import { authenticateRequest, hasScope } from "@/lib/auth";
import { db } from "@/db/index";
import { users } from "@/db/schema";

/**
 * Resolve the platform-admin user for a request, or null.
 *
 * Two authentication paths, both of which require `users.role === "admin"`:
 *  - Dashboard NextAuth session cookie.
 *  - `Authorization: Bearer pmth_…` token carrying the `admin` scope.
 *
 * The DB role is the source of truth on both paths; an admin-scoped token is
 * not sufficient on its own.
 */
export async function getAdminUser(request: NextRequest) {
  const oauthSession = await getServerSession(authOptions);
  if (oauthSession?.user) {
    const sessionUser = oauthSession.user as Record<string, unknown>;
    if (typeof sessionUser.id === "string") {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, sessionUser.id))
        .limit(1);
      const user = rows[0];
      if (user?.role === "admin") {
        return user;
      }
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
