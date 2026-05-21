import { NextRequest, NextResponse } from "next/server";
import { readAppUsage } from "@/domains/developer-apps/runtime/app-usage";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const result = await readAppUsage(request, clientId);
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}
