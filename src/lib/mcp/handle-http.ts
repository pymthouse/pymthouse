import "server-only";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { resolveMcpPrincipal } from "@/lib/mcp/auth";
import { createHostedLivepeerMcpServer } from "@/lib/mcp/hosted-server";

/**
 * Handle one MCP streamable-HTTP request (stateless).
 * Auth: Bearer API key / developer JWT, or Basic M2M — resolved per caller app.
 */
export async function handleHostedMcpHttpRequest(request: Request): Promise<Response> {
  const principal = await resolveMcpPrincipal(request);
  if (!principal) {
    return Response.json(
      {
        error: "unauthorized",
        message:
          "Livepeer MCP requires Authorization: Bearer <API key|JWT> or Basic M2M credentials",
      },
      {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="livepeer-mcp"' },
      },
    );
  }

  const server = createHostedLivepeerMcpServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}
