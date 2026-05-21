import assert from "node:assert/strict";
import test from "node:test";

import {
  addDeveloperAppDomain,
  getAutoWhitelistedDomain,
  getRedirectUriOrigin,
  removeDeveloperAppDomain,
  saveDeveloperAppRedirectUris,
} from "@/domains/developer-apps/ui/app-redirects";

test("getRedirectUriOrigin normalizes valid origins and rejects non-origin URIs", () => {
  assert.equal(
    getRedirectUriOrigin("https://APP.EXAMPLE.com/callback?x=1"),
    "https://app.example.com",
  );
  assert.equal(getRedirectUriOrigin("custom://callback"), null);
  assert.equal(getRedirectUriOrigin("data:text/plain,hello"), null);
  assert.equal(getRedirectUriOrigin("not a url"), null);
});

test("getAutoWhitelistedDomain ignores duplicates and invalid URLs", () => {
  const existing = [{ id: "d1", domain: "https://app.example.com" }];
  assert.equal(
    getAutoWhitelistedDomain("https://APP.EXAMPLE.com/callback", existing),
    null,
  );
  assert.equal(
    getAutoWhitelistedDomain("https://new.example.com/callback", existing),
    "https://new.example.com",
  );
  assert.equal(getAutoWhitelistedDomain("not a url", existing), null);
});

test("saveDeveloperAppRedirectUris sends the expected PUT payload", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    called = true;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, "/api/v1/apps/app_123");
    assert.equal(init?.method, "PUT");
    assert.deepEqual(init?.headers, { "Content-Type": "application/json" });
    assert.equal(init?.body, JSON.stringify({ redirectUris: ["https://rp.example/callback"] }));
    return { ok: true } as Response;
  };

  try {
    await saveDeveloperAppRedirectUris("app_123", ["https://rp.example/callback"]);
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saveDeveloperAppRedirectUris surfaces API errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "Redirect URI rejected" }),
    }) as Response;

  try {
    await assert.rejects(
      saveDeveloperAppRedirectUris("app_123", ["https://rp.example/callback"]),
      /Redirect URI rejected/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("addDeveloperAppDomain and removeDeveloperAppDomain use domain endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method, body: init?.body ?? null });

    if (init?.method === "POST") {
      return {
        ok: true,
        json: async () => ({ id: "d2", domain: "https://new.example.com" }),
      } as Response;
    }

    return { ok: true } as Response;
  };

  try {
    const domain = await addDeveloperAppDomain("app_123", "https://new.example.com");
    assert.deepEqual(domain, { id: "d2", domain: "https://new.example.com" });

    await removeDeveloperAppDomain("app_123", "d2");

    assert.deepEqual(calls, [
      {
        url: "/api/v1/apps/app_123/domains",
        method: "POST",
        body: JSON.stringify({ domain: "https://new.example.com" }),
      },
      {
        url: "/api/v1/apps/app_123/domains?domainId=d2",
        method: "DELETE",
        body: null,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
