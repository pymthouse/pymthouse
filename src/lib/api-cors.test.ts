import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApiCorsHeaders,
  originMatchesAppDomains,
  readConfiguredCorsOrigins,
  resolveApiCorsAllowOrigin,
} from "@/lib/api-cors";

test("resolveApiCorsAllowOrigin allows kongportals.com subdomains", () => {
  assert.equal(
    resolveApiCorsAllowOrigin("https://063fb6f0ed1b.us.kongportals.com", {
      configuredOrigins: [],
      nextAuthUrl: "https://pymthouse.com",
    }),
    "https://063fb6f0ed1b.us.kongportals.com",
  );
});

test("resolveApiCorsAllowOrigin rejects lookalike hosts", () => {
  assert.equal(
    resolveApiCorsAllowOrigin("https://evilkongportals.com", {
      configuredOrigins: [],
      nextAuthUrl: "https://pymthouse.com",
    }),
    null,
  );
  assert.equal(
    resolveApiCorsAllowOrigin("https://kongportals.com.evil.example", {
      configuredOrigins: [],
    }),
    null,
  );
});

test("resolveApiCorsAllowOrigin honors configured list and NEXTAUTH_URL", () => {
  assert.equal(
    resolveApiCorsAllowOrigin("https://portal.example", {
      configuredOrigins: ["https://portal.example"],
      nextAuthUrl: "https://pymthouse.com",
    }),
    "https://portal.example",
  );
  assert.equal(
    resolveApiCorsAllowOrigin("https://pymthouse.com", {
      configuredOrigins: [],
      nextAuthUrl: "https://pymthouse.com",
    }),
    "https://pymthouse.com",
  );
});

test("resolveApiCorsAllowOrigin normalizes trailing slash, casing, and default port", () => {
  assert.equal(
    resolveApiCorsAllowOrigin("https://portal.example", {
      configuredOrigins: ["https://portal.example/"],
    }),
    "https://portal.example",
  );
  assert.equal(
    resolveApiCorsAllowOrigin("https://Portal.Example", {
      configuredOrigins: ["https://portal.example"],
    }),
    "https://Portal.Example",
  );
  assert.equal(
    resolveApiCorsAllowOrigin("https://portal.example", {
      configuredOrigins: ["https://portal.example:443"],
    }),
    "https://portal.example",
  );
  assert.equal(
    resolveApiCorsAllowOrigin("https://pymthouse.com", {
      configuredOrigins: [],
      nextAuthUrl: "https://pymthouse.com/",
    }),
    "https://pymthouse.com",
  );
});

test("resolveApiCorsAllowOrigin allows localhost", () => {
  assert.equal(
    resolveApiCorsAllowOrigin("http://localhost:3000", {
      configuredOrigins: [],
      nextAuthUrl: "https://pymthouse.com",
    }),
    "http://localhost:3000",
  );
});

test("readConfiguredCorsOrigins splits CSV", () => {
  assert.deepEqual(readConfiguredCorsOrigins(" https://a.example ,https://b.example "), [
    "https://a.example",
    "https://b.example",
  ]);
  assert.deepEqual(readConfiguredCorsOrigins(undefined), []);
});

test("buildApiCorsHeaders sets ACAO and Vary", () => {
  const headers = buildApiCorsHeaders("https://portal.kongportals.com");
  assert.equal(headers["Access-Control-Allow-Origin"], "https://portal.kongportals.com");
  assert.equal(headers.Vary, "Origin");
});

test("originMatchesAppDomains is case-insensitive on stored origins", () => {
  assert.equal(
    originMatchesAppDomains("https://App.Example", ["https://app.example"]),
    true,
  );
  assert.equal(
    originMatchesAppDomains("https://other.example", ["https://app.example"]),
    false,
  );
});

test("originMatchesAppDomains matches bare host allowlist entries to Origin", () => {
  assert.equal(
    originMatchesAppDomains("https://app.example", ["app.example"]),
    true,
  );
  assert.equal(
    originMatchesAppDomains("https://app.example", ["https://app.example"]),
    true,
  );
});
