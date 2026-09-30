import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMcpProtectedResourceMetadata,
  buildMcpWwwAuthenticateHeader,
  isMcpResourceIndicator,
  MCP_OAUTH_APP_CLAIM,
  readResourceParam,
} from "@/lib/mcp/oauth-resource";

test("isMcpResourceIndicator matches public origin MCP URL", () => {
  process.env.NEXTAUTH_URL = "https://pymthouse.com";
  assert.equal(
    isMcpResourceIndicator("https://pymthouse.com/api/v1/mcp"),
    true,
  );
  assert.equal(
    isMcpResourceIndicator("https://pymthouse.com/api/v1/mcp/"),
    true,
  );
  assert.equal(
    isMcpResourceIndicator("https://pymthouse.com/api/v1/oidc"),
    false,
  );
});

test("WWW-Authenticate includes resource_metadata", () => {
  process.env.NEXTAUTH_URL = "https://pymthouse.com";
  const header = buildMcpWwwAuthenticateHeader({
    scope: "openid offline_access",
    error: "invalid_token",
  });
  assert.match(header, /^Bearer /);
  assert.match(
    header,
    /resource_metadata="https:\/\/pymthouse\.com\/\.well-known\/oauth-protected-resource\/api\/v1\/mcp"/,
  );
  assert.match(header, /scope="openid offline_access"/);
  assert.match(header, /error="invalid_token"/);
});

test("MCP_OAUTH_APP_CLAIM is stable", () => {
  assert.equal(MCP_OAUTH_APP_CLAIM, "pymthouse_app");
});

test("protected resource metadata includes resource", () => {
  process.env.NEXTAUTH_URL = "https://pymthouse.com";
  const metadata = buildMcpProtectedResourceMetadata();
  assert.equal(metadata.resource, "https://pymthouse.com/api/v1/mcp");
  assert.ok(Array.isArray(metadata.authorization_servers));
});

test("readResourceParam reads string or first array entry", () => {
  assert.equal(readResourceParam({}), null);
  assert.equal(readResourceParam({ resource: "   " }), null);
  assert.equal(
    readResourceParam({ resource: "https://pymthouse.com/api/v1/mcp" }),
    "https://pymthouse.com/api/v1/mcp",
  );
  assert.equal(
    readResourceParam({
      resource: ["https://pymthouse.com/api/v1/mcp", "https://other"],
    }),
    "https://pymthouse.com/api/v1/mcp",
  );
});
