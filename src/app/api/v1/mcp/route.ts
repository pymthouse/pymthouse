import { NextRequest, NextResponse } from "next/server";

import { handleHostedMcpHttpRequest } from "@/lib/mcp/handle-http";
import { readDiscoveryServiceUrl } from "@/lib/mcp/config";
import { getIssuer } from "@/lib/oidc/issuer-urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOSTED_TOOLS = [
  "livepeer_mcp_info",
  "list_network_capabilities",
  "list_discovery_profiles",
  "query_network_orchestrators",
  "get_discovery_freshness",
  "create_signer_session",
] as const;

function metadataResponse(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const mcpUrl = `${origin}/api/v1/mcp`;

  let issuerUrl: string;
  try {
    issuerUrl = getIssuer();
  } catch {
    issuerUrl = "https://pymthouse.com/api/v1/oidc";
  }

  return NextResponse.json({
    name: "Livepeer MCP",
    mode: "hosted",
    description:
      "User-scoped Livepeer MCP for the PymtHouse platform. Authenticate as developer, end-user, or M2M. Network tools follow each app's discovery settings. For live-runner/BYOC/LV2V execution, use the local client in livepeer-python-gateway/examples/comfypeer-mcp.",
    mcp_url: mcpUrl,
    issuer_url: issuerUrl,
    discovery_service_url: readDiscoveryServiceUrl(),
    docs_path: "docs/livepeer-mcp.md",
    auth: {
      type: "http",
      schemes: ["bearer", "basic"],
      description:
        "Bearer: user/developer API key or JWT. Basic: app M2M client_id:client_secret (owner session).",
    },
    tools: [...HOSTED_TOOLS],
    local_client: {
      path: "livepeer-python-gateway/examples/comfypeer-mcp",
      tools: [
        "live_runner_call_tool",
        "byoc_submit_tool",
        "lv2v_start_tool",
        "create_signer_session",
        "list_network_capabilities",
      ],
    },
    cursor_snippet: {
      mcpServers: {
        "livepeer-mcp": {
          url: mcpUrl,
          headers: {
            Authorization: "Bearer <pymthouse-api-key-or-jwt>",
          },
        },
      },
    },
  });
}

/**
 * GET without an MCP session → connect metadata.
 * GET/POST/DELETE with MCP streamable HTTP → hosted MCP tools.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.headers.get("mcp-session-id");
  const accept = request.headers.get("accept") || "";
  if (!sessionId && !accept.includes("text/event-stream")) {
    return metadataResponse(request);
  }
  return handleHostedMcpHttpRequest(request);
}

export async function POST(request: NextRequest) {
  return handleHostedMcpHttpRequest(request);
}

export async function DELETE(request: NextRequest) {
  return handleHostedMcpHttpRequest(request);
}
