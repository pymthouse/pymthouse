import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenIdProviderDiscovery } from "./as-metadata";
import { isTrustedOidcWarmRequest } from "./warm";

test("buildOpenIdProviderDiscovery advertises offline_access without provider init", () => {
  const discovery = buildOpenIdProviderDiscovery();
  const scopes = discovery.scopes_supported;
  assert.ok(Array.isArray(scopes));
  assert.ok((scopes as string[]).includes("offline_access"));
  assert.ok((scopes as string[]).includes("openid"));
  assert.equal(typeof discovery.authorization_endpoint, "string");
  assert.ok(Array.isArray(discovery.claims_supported));
});

test("isTrustedOidcWarmRequest accepts Vercel cron markers when CRON_SECRET unset", () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(
      isTrustedOidcWarmRequest(new Headers({ "x-vercel-cron": "1" })),
      true,
    );
    assert.equal(
      isTrustedOidcWarmRequest(
        new Headers({ "user-agent": "vercel-cron/1.0" }),
      ),
      true,
    );
    assert.equal(isTrustedOidcWarmRequest(new Headers()), false);
  } finally {
    if (previous === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = previous;
    }
  }
});

test("isTrustedOidcWarmRequest requires bearer when CRON_SECRET is set", () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cron-secret";
  try {
    assert.equal(
      isTrustedOidcWarmRequest(new Headers({ "x-vercel-cron": "1" })),
      false,
    );
    assert.equal(
      isTrustedOidcWarmRequest(
        new Headers({ authorization: "Bearer test-cron-secret" }),
      ),
      true,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = previous;
    }
  }
});
