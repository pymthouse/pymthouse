import test from "node:test";
import assert from "node:assert/strict";

import {
  createDcrClientId,
  isAllowedMcpDcrRedirectUri,
  isDcrClientId,
} from "@/lib/oidc/dcr-client";

test("DCR client ids use dcr_ prefix", () => {
  const id = createDcrClientId();
  assert.equal(isDcrClientId(id), true);
  assert.equal(isDcrClientId("app_abc"), false);
});

test("only Claude hosted and RFC 8252 loopback redirect URIs are allowed", () => {
  assert.equal(
    isAllowedMcpDcrRedirectUri("https://claude.ai/api/mcp/auth_callback"),
    true,
  );
  assert.equal(
    isAllowedMcpDcrRedirectUri("https://claude.com/api/mcp/auth_callback"),
    true,
  );
  assert.equal(
    isAllowedMcpDcrRedirectUri("http://localhost:3118/callback"),
    true,
  );
  assert.equal(
    isAllowedMcpDcrRedirectUri("http://127.0.0.1:9999/callback"),
    true,
  );
  assert.equal(
    isAllowedMcpDcrRedirectUri("http://evil.example/callback"),
    false,
  );
  assert.equal(
    isAllowedMcpDcrRedirectUri("https://example.com/oauth/callback"),
    false,
  );
});
