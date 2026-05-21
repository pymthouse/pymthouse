import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";
import { readAdminApps } from "@/domains/developer-apps/runtime/admin-apps";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as Record<string, unknown>).role as string;
  if (role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(await readAdminApps());
}
