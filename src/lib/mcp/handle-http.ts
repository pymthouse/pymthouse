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
    const response = await transport.handleRequest(request);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && response.body) {
      // Defer server.close until the SSE body finishes or the client cancels.
      const { readable, writable } = new TransformStream();
      const closeServer = () => {
        void server.close().catch(() => undefined);
      };
      void response.body.pipeTo(writable).finally(closeServer);
      return new Response(readable, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    await server.close().catch(() => undefined);
    return response;
  } catch (err) {
    await server.close().catch(() => undefined);
    throw err;
  }
}
