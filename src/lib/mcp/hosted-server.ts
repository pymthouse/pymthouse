import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpPrincipal } from "@/lib/mcp/auth";
import { partitionByExclusions } from "@/lib/mcp/capability-allow";
import { readDiscoveryRawUrl, readDiscoveryServiceUrl } from "@/lib/mcp/config";
import { projectDiscoveryQueryResult } from "@/lib/mcp/hosted-server-format";
import {
  cachedAppManifestForApp,
  cachedPlansDiscoveryForApp,
  createSignerSessionForPrincipal,
  discoveryFetch,
} from "@/lib/mcp/session";
import { MintUserSignerTokenError } from "@/lib/oidc/mint-user-signer-token";
import { getIssuer } from "@/lib/oidc/issuer-urls";

const QUERY_ORCHESTRATORS_TOP_N_DEFAULT = 10;
const QUERY_ORCHESTRATORS_TOP_N_MAX = 25;
const DISCOVERY_SERVICE_TYPES = ["live-video-to-video", "live-runner"] as const;

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

function capabilityWireName(pipeline: string, modelId: string): string {
  return `${pipeline}/${modelId}`;
}

function connectionInfo(principal: McpPrincipal): Record<string, unknown> {
  let issuer = "https://pymthouse.com/api/v1/oidc";
  try {
    issuer = getIssuer();
  } catch {
    /* keep default */
  }
  let discoveryServiceUrl: string | null = null;
  let discoveryRawUrl: string | null = null;
  try {
    discoveryServiceUrl = readDiscoveryServiceUrl();
    discoveryRawUrl = readDiscoveryRawUrl();
  } catch {
    /* misconfigured discovery env: report null, keep metadata usable */
  }
  return {
    name: "Livepeer MCP",
    mode: "hosted",
    issuer_url: issuer,
    auth_kind: principal.kind,
    public_client_id: principal.publicClientId,
    developer_app_id: principal.developerAppId,
    discovery_service_url: discoveryServiceUrl,
    discovery_raw_url: discoveryRawUrl,
    local_execution:
      "livepeer-python-gateway/examples/comfypeer-mcp (run_capability / start_stream / call_live_runner)",
  };
}

function signerSessionErrorMessage(err: MintUserSignerTokenError): string {
  if (err.code === "invalid_scope") {
    return (
      `${err.code}: ${err.message}. ` +
      "Grant sign:job on the authenticating M2M client and its public app_ sibling " +
      "(user/API-key callers need sign:job on the public client). " +
      "Then retry create_signer_session with confirm=true."
    );
  }
  return `${err.code}: ${err.message}. Fix the error and retry create_signer_session with confirm=true.`;
}

/**
 * Hosted Livepeer MCP: user-scoped platform MCP on PymtHouse.
 * Auth is the caller's developer/end-user/M2M credential (no fixed app M2M behind MCP).
 * Network tools are scoped by the app's network discovery / manifest settings.
 * Execution (`run_capability` / `start_stream` / `call_live_runner`) stays in the local
 * livepeer-python-gateway examples/comfypeer-mcp client.
 */
export function createHostedLivepeerMcpServer(principal: McpPrincipal): McpServer {
  const server = new McpServer({
    name: "Livepeer MCP",
    version: "0.1.0",
    description:
      "Hosted Livepeer MCP on PymtHouse. Authenticate as developer, end-user, or M2M " +
      "(Authorization: Bearer <API key|JWT>, or Basic M2M). " +
      "Tools: query_orchestrators, get_discovery_freshness, list_capabilities, " +
      "list_discovery_profiles, create_signer_session. " +
      "Connection metadata is the livepeer://mcp/info resource. " +
      "For run_capability / start_stream / call_live_runner, use " +
      "livepeer-python-gateway/examples/comfypeer-mcp.",
  });

  server.registerResource(
    "livepeer_mcp_info",
    "livepeer://mcp/info",
    {
      description:
        "Read-only Livepeer MCP connection metadata (issuer, discovery URLs, principal). Not a tool.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(connectionInfo(principal)),
        },
      ],
    }),
  );

  server.registerTool(
    "list_capabilities",
    {
      description:
        "Use to see which pipeline/model wire names query_orchestrators will accept. " +
        "Do not use for plan prices or discovery policy — that is list_discovery_profiles. " +
        "Returns a summary (capability names, excluded names, manifestVersion, total_count).",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const manifest = await cachedAppManifestForApp(principal.developerAppId);
      const capabilities = manifest.capabilities.map((c) =>
        capabilityWireName(c.pipeline, c.modelId),
      );
      const excludedCapabilities = manifest.excludedCapabilities.map((c) =>
        capabilityWireName(c.pipeline, c.modelId),
      );
      return textResult({
        source: "app_manifest",
        public_client_id: principal.publicClientId,
        manifestVersion: manifest.manifestVersion,
        total_count: capabilities.length,
        capabilities,
        excludedCapabilities,
      });
    },
  );

  server.registerTool(
    "list_discovery_profiles",
    {
      description:
        "Use for plan bundles / max_price_per_unit. Do not use to pick a capability name " +
        "for a query — that is list_capabilities.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const plans = await cachedPlansDiscoveryForApp(principal.developerAppId);
      return textResult({
        public_client_id: principal.publicClientId,
        plans: plans.map((row) => ({
          plan_id: row.plan.id,
          plan_name: row.plan.name,
          discovery_profile_id: row.discoveryProfileId,
          discovery_policy: row.discoveryPolicy,
          capabilities: row.capabilities.map((c) => ({
            pipeline: c.pipeline,
            model_id: c.modelId,
            discovery_policy: c.discoveryPolicy,
            max_price_per_unit: c.maxPricePerUnit,
            retail_rate_usd: c.retailRateUsd,
          })),
        })),
      });
    },
  );

  server.registerTool(
    "query_orchestrators",
    {
      description:
        "Query ranked orchestrators for capability wire names. Call list_capabilities first " +
        "if you do not already have a name. Do not call this for plan prices " +
        "(list_discovery_profiles) or connection metadata (livepeer://mcp/info). " +
        "Returns projected orchestrators (id, avail, price, capabilities) plus total_count.",
      inputSchema: {
        capabilities: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Wire names, e.g. ['live-video-to-video/streamdiffusion-sdxl'] or a bare token",
          ),
        service_types: z
          .array(z.enum(DISCOVERY_SERVICE_TYPES))
          .optional()
          .describe("Defaults to both live-video-to-video and live-runner"),
        top_n: z
          .number()
          .int()
          .min(1)
          .max(QUERY_ORCHESTRATORS_TOP_N_MAX)
          .optional()
          .describe(
            `Max orchestrators to return. Default ${QUERY_ORCHESTRATORS_TOP_N_DEFAULT}. Do not use the REST cap of 1000.`,
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ capabilities, service_types, top_n }) => {
      const manifest = await cachedAppManifestForApp(principal.developerAppId);
      const { permitted, excluded } = partitionByExclusions(
        capabilities,
        manifest.excludedCapabilities,
      );
      if (permitted.length === 0) {
        const example =
          manifest.capabilities[0] != null
            ? capabilityWireName(
                manifest.capabilities[0].pipeline,
                manifest.capabilities[0].modelId,
              )
            : "live-video-to-video/streamdiffusion-sdxl";
        return errorResult(
          `all requested capabilities are excluded for this app. Example allowed spelling: "${example}". Call list_capabilities and retry with names absent from excludedCapabilities.`,
        );
      }
      try {
        const data = await discoveryFetch("/v1/discovery/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            capabilities: permitted,
            serviceTypes: service_types ?? [...DISCOVERY_SERVICE_TYPES],
            topN: top_n ?? QUERY_ORCHESTRATORS_TOP_N_DEFAULT,
            sortBy: "avail",
          }),
        });
        const projected = projectDiscoveryQueryResult(data);
        return textResult({
          filtered_capabilities: permitted,
          dropped_capabilities: excluded,
          total_count: projected.total_count,
          orchestrators: projected.orchestrators,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Discovery query failed";
        return errorResult(
          `Discovery query failed (${message}). Retry query_orchestrators after list_capabilities confirms the wire names.`,
        );
      }
    },
  );

  server.registerTool(
    "get_discovery_freshness",
    {
      description: "Discovery-service dataset freshness. Do not use this to pick orchestrators.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const data = await discoveryFetch(
          "/v1/discovery/freshness",
          undefined,
          { cacheTtlMs: 15_000 },
        );
        return textResult(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Discovery freshness failed";
        return errorResult(
          `Discovery freshness failed (${message}). Retry later; do not treat this as a capability name.`,
        );
      }
    },
  );

  server.registerTool(
    "create_signer_session",
    {
      description:
        "Mint a SignerSession (access_token + optional sdk_token) for the authenticated principal. " +
        "Requires confirm=true. Do not call for discovery or connection metadata.",
      inputSchema: {
        confirm: z
          .literal(true)
          .describe("Must be true. Gates credential mint in the client UI."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async () => {
      try {
        const session = await createSignerSessionForPrincipal(principal);
        return textResult(session);
      } catch (err) {
        if (err instanceof MintUserSignerTokenError) {
          return errorResult(signerSessionErrorMessage(err));
        }
        throw err;
      }
    },
  );

  return server;
}
