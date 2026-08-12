import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildAppManifestForApp } from "@/lib/app-manifest";
import { DISCOVERY_TOP_N_MAX } from "@/lib/discovery-plans";
import { resolvePlansDiscoveryForApp } from "@/lib/discovery-profile-resolve";
import type { McpPrincipal } from "@/lib/mcp/auth";
import { partitionByExclusions } from "@/lib/mcp/capability-allow";
import { readDiscoveryRawUrl, readDiscoveryServiceUrl } from "@/lib/mcp/config";
import { createSignerSessionForPrincipal, discoveryFetch } from "@/lib/mcp/session";
import { MintUserSignerTokenError } from "@/lib/oidc/mint-user-signer-token";
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
      let discoveryServiceUrl: string | null = null;
      let discoveryRawUrl: string | null = null;
      try {
        discoveryServiceUrl = readDiscoveryServiceUrl();
        discoveryRawUrl = readDiscoveryRawUrl();
      } catch {
        /* misconfigured discovery env: report null, keep metadata usable */
      }
      return textResult({
        name: "Livepeer MCP",
        mode: "hosted",
        issuer_url: issuer,
        auth_kind: principal.kind,
        public_client_id: principal.publicClientId,
        developer_app_id: principal.developerAppId,
        // Origin used by query_orchestrators / get_discovery_freshness.
        discovery_service_url: discoveryServiceUrl,
        // Full raw endpoint embedded in livepeer-python-gateway `--token`.
        discovery_raw_url: discoveryRawUrl,
        local_execution:
          "livepeer-python-gateway/examples/comfypeer-mcp (run_capability / start_stream / call_live_runner)",
      });
    },
  );

  server.registerTool(
    "list_capabilities",
    {
      description:
        "List the app-scoped network capability catalog (network default plan minus discovery exclusions) " +
        "from PymtHouse application settings. Informational: this catalog does not gate requests — " +
        "only `excludedCapabilities` restricts what `query_orchestrators` will forward.",
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
        "Query ranked orchestrators for capability names. Requests pass through unless this app explicitly excludes them.",
      inputSchema: {
        capabilities: z.array(z.string()).min(1),
        service_types: z.array(z.string()).optional(),
        top_n: z.number().int().positive().max(DISCOVERY_TOP_N_MAX).optional(),
      },
    },
    async ({ capabilities, service_types, top_n }) => {
      const manifest = await buildAppManifestForApp(principal.developerAppId);
      // Fail open: discovery limits capabilities, it does not grant them. The
      // resolved `capabilities` list is a catalog view, not an entitlement —
      // orchestrators advertise names the catalog does not always enumerate, so
      // gating on it would deny capabilities the app never excluded. Only
      // `excludedCapabilities` restricts, and a catalog outage preserves those
      // (see `buildManifestWhenCatalogUnavailable`) while leaving the rest
      // reachable.
      const { permitted, excluded } = partitionByExclusions(
        capabilities,
        manifest.excludedCapabilities,
      );
      if (permitted.length === 0) {
        return textResult({
          error: "all_requested_capabilities_excluded_for_app",
          requested: capabilities,
          excluded_capabilities: excluded,
          manifest_version: manifest.manifestVersion,
        });
      }
      const data = await discoveryFetch("/v1/discovery/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capabilities: permitted,
          serviceTypes: service_types ?? ["live-video-to-video", "live-runner"],
          topN: top_n ?? 50,
          sortBy: "avail",
        }),
      });
      return textResult({
        filtered_capabilities: permitted,
        dropped_capabilities: excluded,
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
      try {
        const session = await createSignerSessionForPrincipal(principal);
        return textResult(session);
      } catch (err) {
        if (err instanceof MintUserSignerTokenError) {
          return errorResult(`${err.code}: ${err.message}`);
        }
        throw err;
      }
    },
  );

  return server;
}
