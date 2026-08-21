import test from "node:test";
import assert from "node:assert/strict";

import { deriveExternalOriginFromHeaders, resolveRedirectLocation, isLoopbackHttpRedirect } from "./utils";

test("deriveExternalOriginFromHeaders prefers forwarded host+proto", () => {
  const headers = new Headers({
    "x-forwarded-host": "pymthouse.com",
    "x-forwarded-proto": "https",
  });
  assert.equal(deriveExternalOriginFromHeaders(headers), "https://pymthouse.com");
});

test("deriveExternalOriginFromHeaders handles proxy header chains", () => {
  const headers = new Headers({
    "x-forwarded-host": "pymthouse.com, 127.0.0.1:3001",
    "x-forwarded-proto": "https, http",
  });
  assert.equal(deriveExternalOriginFromHeaders(headers), "https://pymthouse.com");
});

test("resolveRedirectLocation resolves provider relative redirects against external origin", () => {
  const redirect = resolveRedirectLocation("/auth/abc123", "https://pymthouse.com");
  assert.equal(redirect.href, "https://pymthouse.com/api/v1/oidc/auth/abc123");
});

test("resolveRedirectLocation passes absolute URL when origin is in allowed set", () => {
  const allowed = new Set(["https://app.example.com"]);
  const redirect = resolveRedirectLocation(
    "https://app.example.com/callback?code=abc",
    "https://pymthouse.com",
    allowed,
  );
  assert.equal(redirect.href, "https://app.example.com/callback?code=abc");
});

test("resolveRedirectLocation allows Claude Code loopback redirects", () => {
  const allowed = new Set(["https://pymthouse.com"]);
  const redirect = resolveRedirectLocation(
    "http://localhost:52262/callback?code=abc&state=xyz",
    "https://pymthouse.com",
    allowed,
  );
  assert.equal(
    redirect.href,
    "http://localhost:52262/callback?code=abc&state=xyz",
  );
});

test("resolveRedirectLocation allows Claude hosted callback origins", () => {
  const allowed = new Set(["https://pymthouse.com"]);
  const redirect = resolveRedirectLocation(
    "https://claude.ai/api/mcp/auth_callback?code=abc",
    "https://pymthouse.com",
    allowed,
  );
  assert.equal(
    redirect.href,
    "https://claude.ai/api/mcp/auth_callback?code=abc",
  );
});

test("isLoopbackHttpRedirect accepts RFC 8252 callback hosts only", () => {
  assert.equal(
    isLoopbackHttpRedirect(new URL("http://localhost:1/callback")),
    true,
  );
  assert.equal(
    isLoopbackHttpRedirect(new URL("http://127.0.0.1:1/callback")),
    true,
  );
  assert.equal(
    isLoopbackHttpRedirect(new URL("http://[::1]/callback")),
    true,
  );
  assert.equal(
    isLoopbackHttpRedirect(new URL("http://evil.example/callback")),
    false,
  );
  assert.equal(
    isLoopbackHttpRedirect(new URL("https://localhost/callback")),
    false,
  );
  assert.equal(
    isLoopbackHttpRedirect(new URL("http://localhost:1/nested/callback")),
    false,
  );
  assert.equal(
    isLoopbackHttpRedirect(new URL("http://user:pass@127.0.0.1/callback")),
    false,
  );
});

test("resolveRedirectLocation passes server-origin absolute URL when allowed", () => {
  const allowed = new Set(["https://pymthouse.com"]);
  const redirect = resolveRedirectLocation(
    "https://pymthouse.com/api/v1/oidc/auth/uid123",
    "https://pymthouse.com",
    allowed,
  );
  assert.equal(redirect.href, "https://pymthouse.com/api/v1/oidc/auth/uid123");
});

test("resolveRedirectLocation throws when absolute URL origin is not in allowed set", () => {
  const allowed = new Set(["https://pymthouse.com", "https://app.example.com"]);
  assert.throws(
    () => resolveRedirectLocation("https://evil.example.com/steal", "https://pymthouse.com", allowed),
    /Redirect to unregistered origin blocked/,
  );
});

test("resolveRedirectLocation permits absolute URL when no allowedOrigins set provided", () => {
  // No allowed set — backward-compatible permissive behaviour
  const redirect = resolveRedirectLocation("https://any.example.com/cb", "https://pymthouse.com");
  assert.equal(redirect.href, "https://any.example.com/cb");
});
