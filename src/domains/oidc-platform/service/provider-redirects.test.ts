import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveExternalOriginFromHeaders,
  resolveRedirectLocation,
} from "./provider-redirects";

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
