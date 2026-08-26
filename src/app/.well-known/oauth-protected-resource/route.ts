import { NextResponse } from "next/server";

import { buildMcpProtectedResourceMetadata } from "@/lib/mcp/oauth-resource";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildMcpProtectedResourceMetadata(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
