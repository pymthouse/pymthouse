/**
 * Withdraw from review — transition from submitted back to draft (owner only).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";
import { getProviderApp } from "@/domains/developer-apps/repo/provider-access";
import { revertOwnedAppToDraft } from "@/domains/developer-apps/runtime/app-core";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as Record<string, unknown>).id as string;
  const { id: clientId } = await params;
  const app = await getProviderApp(clientId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const result = await revertOwnedAppToDraft({ app, userId });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}
