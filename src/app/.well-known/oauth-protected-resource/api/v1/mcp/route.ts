import { NextResponse } from "next/server";

import { buildMcpProtectedResourceMetadata } from "@/lib/mcp/oauth-resource";

/**
 * Path-aware RFC 9728 metadata for the hosted MCP resource
 * (`/.well-known/oauth-protected-resource/api/v1/mcp`).
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildMcpProtectedResourceMetadata(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
