import { NextRequest, NextResponse } from "next/server";

import { handleHostedMcpHttpRequest } from "@/lib/mcp/handle-http";
import { readDiscoveryRawUrl, readDiscoveryServiceUrl } from "@/lib/mcp/config";
import { getIssuer } from "@/lib/oidc/issuer-urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOSTED_TOOLS = [
  "list_capabilities",
  "list_discovery_profiles",
  "query_orchestrators",
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

  // Public, unauthenticated connect metadata: a discovery misconfiguration must
  // degrade these two fields, not 500 the whole handshake.
  let discoveryServiceUrl: string | null = null;
  let discoveryRawUrl: string | null = null;
  try {
    discoveryServiceUrl = readDiscoveryServiceUrl();
    discoveryRawUrl = readDiscoveryRawUrl();
  } catch {
    /* leave both null */
  }

  return NextResponse.json({
    name: "Livepeer MCP",
    mode: "hosted",
    description:
      "User-scoped Livepeer MCP for the PymtHouse platform. Authenticate as developer, end-user, or M2M. Network tools follow each app's discovery settings. For run_capability / start_stream / call_live_runner, use the local client in livepeer-python-gateway/examples/comfypeer-mcp.",
    mcp_url: mcpUrl,
    issuer_url: issuerUrl,
    discovery_service_url: discoveryServiceUrl,
    discovery_raw_url: discoveryRawUrl,
    docs_path: "docs/livepeer-mcp.md",
    auth: {
      type: "http",
      schemes: ["bearer", "basic", "oauth2"],
      description:
        "Bearer: user/developer API key or JWT (including MCP OAuth tokens). Basic: app M2M client_id:client_secret (owner session). OAuth: auth code + PKCE via Claude connector UI (open DCR).",
      oauth: {
        resource: mcpUrl,
        authorization_servers: [issuerUrl],
        protected_resource_metadata: `${origin}/.well-known/oauth-protected-resource/api/v1/mcp`,
      },
    },
    tools: [...HOSTED_TOOLS],
    resources: ["livepeer://mcp/info"],
    local_client: {
      path: "livepeer-python-gateway/examples/comfypeer-mcp",
      tools: [
        "list_capabilities",
        "run_capability",
        "start_stream",
        "call_live_runner",
        "create_signer_session",
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
