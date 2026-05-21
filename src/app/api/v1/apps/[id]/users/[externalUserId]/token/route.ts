import { NextRequest, NextResponse } from "next/server";
import { issueAppUserProgrammaticToken } from "@/domains/developer-apps/runtime/app-user-tokens";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId } = await params;
  const result = await issueAppUserProgrammaticToken({
    request,
    clientId,
    externalUserId,
  });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}
