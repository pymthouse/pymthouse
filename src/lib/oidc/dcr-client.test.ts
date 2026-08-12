import test from "node:test";
import assert from "node:assert/strict";
import { errors } from "oidc-provider";
import type { KoaContextWithOIDC } from "oidc-provider";

import {
  applyMcpDcrRegistrationPolicy,
  createDcrClientId,
  DCR_ALLOWED_SCOPES,
  filterScopesToAllowlist,
  isAllowedMcpDcrRedirectUri,
  isDcrClientId,
  mcpDcrRegisteredScope,
  parseScopeParam,
} from "@/lib/oidc/dcr-client";
import { MCP_RESOURCE_SCOPES } from "@/lib/mcp/oauth-resource";

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

test("DCR allowlist matches MCP resource scopes (consent display + grant)", () => {
  assert.deepEqual([...DCR_ALLOWED_SCOPES], [...MCP_RESOURCE_SCOPES]);
  assert.ok(DCR_ALLOWED_SCOPES.includes("openid"));
  assert.ok(DCR_ALLOWED_SCOPES.includes("offline_access"));
  assert.ok(DCR_ALLOWED_SCOPES.includes("sign:job"));
  assert.equal(DCR_ALLOWED_SCOPES.includes("admin"), false);
  assert.equal(DCR_ALLOWED_SCOPES.includes("users:write"), false);
});

test("filterScopesToAllowlist strips privileged scopes hidden from consent UI", () => {
  const granted = filterScopesToAllowlist(
    "openid profile email offline_access sign:job admin users:write",
    DCR_ALLOWED_SCOPES,
  );
  assert.deepEqual(granted, [
    "openid",
    "profile",
    "email",
    "offline_access",
    "sign:job",
  ]);
  assert.equal(granted.includes("admin"), false);
  assert.equal(granted.includes("users:write"), false);
});

test("filterScopesToAllowlist preserves request order and ignores unknown tokens", () => {
  assert.deepEqual(
    filterScopesToAllowlist("sign:job openid bogus", DCR_ALLOWED_SCOPES),
    ["sign:job", "openid"],
  );
  assert.deepEqual(filterScopesToAllowlist(undefined, DCR_ALLOWED_SCOPES), []);
  assert.deepEqual(parseScopeParam("openid  openid\temail"), [
    "openid",
    "email",
  ]);
});

test("DCR registration policy overwrites client-supplied privileged scopes", () => {
  const properties: Record<string, unknown> = {
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    scope: "openid admin users:write offline_access",
  };
  applyMcpDcrRegistrationPolicy(
    {} as KoaContextWithOIDC,
    properties,
  );
  assert.equal(properties.scope, mcpDcrRegisteredScope());
  const scopes = String(properties.scope).split(/\s+/);
  assert.equal(scopes.includes("admin"), false);
  assert.equal(scopes.includes("users:write"), false);
  assert.ok(scopes.includes("openid"));
  assert.ok(scopes.includes("sign:job"));
});

test("DCR registration policy skips enforcement for static clients (no ctx)", () => {
  const properties: Record<string, unknown> = {
    scope: "admin",
  };
  applyMcpDcrRegistrationPolicy(undefined, properties);
  assert.equal(properties.scope, "admin");
});

test("DCR registration policy rejects disallowed redirect URIs", () => {
  assert.throws(
    () =>
      applyMcpDcrRegistrationPolicy({} as KoaContextWithOIDC, {
        redirect_uris: ["http://evil.example/callback"],
      }),
    (err: unknown) => err instanceof errors.InvalidClientMetadata,
  );
});
