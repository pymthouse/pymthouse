import assert from "node:assert/strict";

import { test } from "node:test";

import { isOidcHandshakePath } from "./handshake-path";

test("isOidcHandshakePath matches interaction and provider mounts", () => {
  assert.equal(isOidcHandshakePath("/oidc/interaction"), true);
  assert.equal(isOidcHandshakePath("/oidc/consent"), true);
  assert.equal(isOidcHandshakePath("/api/v1/oidc/auth/abc"), true);
  assert.equal(isOidcHandshakePath("/api/v1/oidc"), true);
  assert.equal(isOidcHandshakePath("/login"), false);
  assert.equal(isOidcHandshakePath("/api/v1/apps/x"), false);
});
