import { NextRequest, NextResponse } from "next/server";

import { handleHostedMcpHttpRequest } from "@/lib/mcp/handle-http";
import { buildMcpProtectedResourceMetadata } from "@/lib/mcp/oauth-resource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unauthenticated GET is RFC 9728 protected-resource metadata (must include
 * `resource`). Codex treats HTTP 200 as that document. Tool calls without a
 * token still return 401 + WWW-Authenticate from the hosted handler.
 */
function protectedResourceResponse() {
  return NextResponse.json(buildMcpProtectedResourceMetadata(), {
    headers: {
      "Cache-Control": "public, max-age=60",
      "Content-Type": "application/json",
    },
  });
}

/**
 * GET without an MCP session → RFC 9728 metadata.
 * GET/POST/DELETE with MCP streamable HTTP → hosted MCP tools.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.headers.get("mcp-session-id");
  const accept = request.headers.get("accept") || "";
  if (!sessionId && !accept.includes("text/event-stream")) {
    return protectedResourceResponse();
  }
  return handleHostedMcpHttpRequest(request);
}

export async function POST(request: NextRequest) {
  return handleHostedMcpHttpRequest(request);
}

export async function DELETE(request: NextRequest) {
  return handleHostedMcpHttpRequest(request);
}
