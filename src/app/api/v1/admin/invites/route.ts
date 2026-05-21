import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";
import {
  issueAdminInvite,
  readOpenAdminInvites,
  redeemAdminInvite,
} from "@/domains/identity-access/runtime/admin-invites";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as Record<string, unknown>)?.role as string;
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const userId = (session.user as Record<string, unknown>)?.id as string;
  const { code, expiresAt } = await issueAdminInvite(userId);
  return NextResponse.json({ code, expiresAt });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as Record<string, unknown>)?.role as string;
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const invites = await readOpenAdminInvites();
  return NextResponse.json({ invites });
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as Record<string, unknown>)?.id as string;
  const body = await req.json();
  const { code } = body;

  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "Invite code required" }, { status: 400 });
  }

  const result = await redeemAdminInvite(code, userId);
  return NextResponse.json(result.body, { status: result.status });
}
