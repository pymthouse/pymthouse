import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";
import { authenticateRequest, hasScope } from "@/domains/identity-access/runtime/request-auth";
import { getUserById } from "../repo/admin-auth";

export async function getSignerAdminUser(request: NextRequest) {
  const oauthSession = await getServerSession(authOptions);
  if (oauthSession?.user) {
    const sessionUser = oauthSession.user as Record<string, unknown>;
    if (sessionUser.id) {
      const user = await getUserById(sessionUser.id as string);
      if (user?.role === "admin") return user;
    }
  }

  const auth = await authenticateRequest(request);
  if (auth && hasScope(auth.scopes, "admin") && auth.userId) {
    const user = await getUserById(auth.userId);
    if (user?.role === "admin") return user;
  }

  return null;
}
