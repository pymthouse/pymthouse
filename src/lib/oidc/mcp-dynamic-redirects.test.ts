import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedClientRedirectUri,
  redirectUrisMatch,
} from "@/lib/oidc/mcp-dynamic-redirects";

test("accepts Claude, Cursor, ChatGPT, and loopback redirects", () => {
  assert.equal(
    isAllowedClientRedirectUri("https://claude.ai/api/mcp/auth_callback"),
    true,
  );
  assert.equal(
    isAllowedClientRedirectUri("https://claude.com/api/mcp/auth_callback"),
    true,
  );
  assert.equal(
    isAllowedClientRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback"),
    true,
  );
  assert.equal(
    isAllowedClientRedirectUri(
      "https://www.cursor.com/agents/mcp/oauth/callback",
    ),
    true,
  );
  assert.equal(
    isAllowedClientRedirectUri(
      "https://cursor.com/agents/mcp/oauth/callback",
    ),
    true,
  );
  assert.equal(
    isAllowedClientRedirectUri("http://localhost:8787/callback"),
    true,
  );
  assert.equal(
    isAllowedClientRedirectUri(
      "https://chatgpt.com/connector_platform_oauth_redirect",
    ),
    true,
  );
  assert.equal(
    isAllowedClientRedirectUri(
      "https://chatgpt.com/connector/oauth/BKj9umzr4ef_",
    ),
    true,
  );
  assert.equal(
    isAllowedClientRedirectUri("http://127.0.0.1:3118/nested/callback"),
    true,
  );
  assert.equal(isAllowedClientRedirectUri("http://[::1]/callback"), true);
});

test("rejects other https origins and credentialed loopback", () => {
  assert.equal(
    isAllowedClientRedirectUri("https://example.com/oauth/callback"),
    false,
  );
  assert.equal(
    isAllowedClientRedirectUri("https://evil.cursor.com/agents/mcp/oauth/callback"),
    false,
  );
  assert.equal(
    isAllowedClientRedirectUri("https://chatgpt.com/oauth/codex/client.json"),
    false,
  );
  assert.equal(
    isAllowedClientRedirectUri("http://evil.example/callback"),
    false,
  );
  assert.equal(
    isAllowedClientRedirectUri("http://user:pass@127.0.0.1/callback"),
    false,
  );
});

test("loopback port and 127.0.0.1 ↔ localhost equivalence", () => {
  assert.equal(
    redirectUrisMatch(
      "http://127.0.0.1/callback",
      "http://127.0.0.1:58123/callback",
    ),
    true,
  );
  assert.equal(
    redirectUrisMatch(
      "http://127.0.0.1/callback",
      "http://localhost:58123/callback",
    ),
    true,
  );
  assert.equal(
    redirectUrisMatch(
      "http://localhost/callback",
      "http://[::1]:9000/callback",
    ),
    true,
  );
  assert.equal(
    redirectUrisMatch(
      "http://127.0.0.1/callback",
      "http://127.0.0.1:58123/other",
    ),
    false,
  );
  assert.equal(
    redirectUrisMatch(
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback",
    ),
    true,
  );
  assert.equal(
    redirectUrisMatch(
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "https://cursor.com/agents/mcp/oauth/callback",
    ),
    false,
  );
});
