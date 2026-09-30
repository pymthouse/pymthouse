import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogClientFromCimdUrl,
  identifyMcpCatalogClient,
  MCP_CURSOR_STATIC_CLIENT_ID,
} from "@/lib/mcp/catalog";

test("CIMD URLs map to catalog clients", () => {
  assert.equal(
    catalogClientFromCimdUrl(
      "https://claude.ai/oauth/mcp-oauth-client-metadata",
    ),
    "claude",
  );
  assert.equal(
    catalogClientFromCimdUrl(
      "https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json",
    ),
    "hermes",
  );
  assert.equal(
    catalogClientFromCimdUrl(
      "https://chatgpt.com/oauth/codex/client.json",
    ),
    "codex",
  );
  assert.equal(
    catalogClientFromCimdUrl(
      "https://chatgpt.com/oauth/BKj9umzr4ef_/client.json",
    ),
    "chatgpt",
  );
  assert.equal(
    catalogClientFromCimdUrl("https://gist.github.com/foo/bar"),
    null,
  );
});

test("identifyMcpCatalogClient uses static id, CIMD, redirects, then name", () => {
  assert.equal(
    identifyMcpCatalogClient({ clientId: MCP_CURSOR_STATIC_CLIENT_ID }),
    "cursor",
  );
  assert.equal(
    identifyMcpCatalogClient({
      clientId: "dcr_abc",
      redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
    }),
    "cursor",
  );
  assert.equal(
    identifyMcpCatalogClient({
      clientId: "dcr_abc",
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    }),
    "chatgpt",
  );
  assert.equal(
    identifyMcpCatalogClient({
      clientId: "dcr_abc",
      clientName: "Hermes Agent",
    }),
    "hermes",
  );
  assert.equal(
    identifyMcpCatalogClient({
      clientId: "dcr_abc",
      redirectUris: ["http://127.0.0.1:9/callback"],
      clientName: "MCP Connector",
    }),
    null,
  );
});
