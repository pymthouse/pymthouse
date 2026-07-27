import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { listSessionUserApiKeys } from "@/lib/app-api-keys";

/**
 * List API keys bound to the signed-in user across all apps.
 * Secrets are never returned — only masked prefix/suffix identifiers.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as Record<string, unknown>).id as string | undefined;
  if (!userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  const role = (session.user as Record<string, unknown>).role as string | undefined;
  if (role === "admin" || role === "operator") {
    return NextResponse.json(
      { error: "Platform admins manage keys per app, not via personal keys" },
      { status: 400 },
    );
  }

  const keys = await listSessionUserApiKeys(userId);
  const activeCount = keys.filter((k) => k.status === "active").length;

  return NextResponse.json({
    keys,
    activeCount,
    totalCount: keys.length,
  });
}
