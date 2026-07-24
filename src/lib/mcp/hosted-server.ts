import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildAppManifestForApp } from "@/lib/app-manifest";
import { resolvePlansDiscoveryForApp } from "@/lib/discovery-profile-resolve";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { filterAllowedCapabilities } from "@/lib/mcp/capability-allow";
import { readDiscoveryServiceUrl } from "@/lib/mcp/config";
import { createSignerSessionForPrincipal, discoveryFetch } from "@/lib/mcp/session";
import { getIssuer } from "@/lib/oidc/issuer-urls";

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
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
      "Tools cover app network capabilities and create_signer_session. " +
      "For run_capability / start_stream / call_live_runner, use " +
      "livepeer-python-gateway/examples/comfypeer-mcp.",
  });

  server.registerTool(
    "livepeer_mcp_info",
    {
      description: "Hosted Livepeer MCP metadata for the authenticated principal (no secrets).",
      inputSchema: {},
    },
    async () => {
      let issuer = "https://pymthouse.com/api/v1/oidc";
      try {
        issuer = getIssuer();
      } catch {
        /* keep default */
      }
      return textResult({
        name: "Livepeer MCP",
        mode: "hosted",
        issuer_url: issuer,
        auth_kind: principal.kind,
        public_client_id: principal.publicClientId,
        developer_app_id: principal.developerAppId,
        discovery_service_url: readDiscoveryServiceUrl(),
        local_execution:
          "livepeer-python-gateway/examples/comfypeer-mcp (run_capability / start_stream / call_live_runner)",
      });
    },
  );

  server.registerTool(
    "list_capabilities",
    {
      description:
        "List network capabilities allowed for this app (network default plan / discovery exclusions). " +
        "This is the app-scoped catalog from PymtHouse application settings.",
      inputSchema: {},
    },
    async () => {
      const manifest = await buildAppManifestForApp(principal.developerAppId);
      return textResult({
        source: "app_manifest",
        public_client_id: principal.publicClientId,
        ...manifest,
      });
    },
  );

  server.registerTool(
    "list_discovery_profiles",
    {
      description:
        "List discovery profiles and plan capability bundles configured for this app.",
      inputSchema: {},
    },
    async () => {
      const plans = await resolvePlansDiscoveryForApp(principal.developerAppId);
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
        "Query ranked orchestrators for capability names. Requests are filtered to this app's network allowlist.",
      inputSchema: {
        capabilities: z.array(z.string()).min(1),
        service_types: z.array(z.string()).optional(),
        top_n: z.number().int().positive().optional(),
      },
    },
    async ({ capabilities, service_types, top_n }) => {
      const manifest = await buildAppManifestForApp(principal.developerAppId);
      const filtered = filterAllowedCapabilities(
        capabilities,
        manifest.capabilities,
      );
      if (filtered.length === 0) {
        return textResult({
          error: "none_of_requested_capabilities_allowed_for_app",
          requested: capabilities,
          allowed_sample: manifest.capabilities.slice(0, 25),
          manifest_version: manifest.manifestVersion,
        });
      }
      const data = await discoveryFetch("/v1/discovery/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capabilities: filtered,
          serviceTypes: service_types ?? ["live-video-to-video", "live-runner"],
          topN: top_n ?? 50,
          sortBy: "avail",
        }),
      });
      return textResult({
        filtered_capabilities: filtered,
        dropped_capabilities: capabilities.filter((c) => !filtered.includes(c)),
        result: data,
      });
    },
  );

  server.registerTool(
    "get_discovery_freshness",
    {
      description: "Discovery-service dataset freshness.",
      inputSchema: {},
    },
    async () => {
      const data = await discoveryFetch("/v1/discovery/freshness");
      return textResult(data);
    },
  );

  server.registerTool(
    "create_signer_session",
    {
      description:
        "Mint a SignerSession for the authenticated principal (+ optional base64 SDK --token for local livepeer-python-gateway).",
      inputSchema: {},
    },
    async () => {
      const session = await createSignerSessionForPrincipal(principal);
      return textResult(session);
    },
  );

  return server;
}
