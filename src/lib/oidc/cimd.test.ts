import assert from "node:assert/strict";
import test from "node:test";

import {
  clearCimdCache,
  isAllowedCimdClientId,
  resolveCimdClient,
} from "@/lib/oidc/cimd";

const CODEX_CIMD = "https://chatgpt.com/oauth/codex/BKj9umzr4ef_/client.json";
const CODEX_STABLE = "https://chatgpt.com/oauth/codex/client.json";
const CHATGPT_CIMD = "https://chatgpt.com/oauth/BKj9umzr4ef_/client.json";
const CLAUDE_CIMD = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_COM_CIMD = "https://claude.com/oauth/mcp-oauth-client-metadata";
const HERMES_CIMD =
  "https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json";
const HERMES_REDIRECTS = [
  "http://127.0.0.1:27890/callback",
  "http://localhost:27890/callback",
  "http://127.0.0.1:27891/callback",
  "http://localhost:27891/callback",
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Claude, Hermes, Codex, and ChatGPT CIMD URLs are allowed", () => {
  assert.equal(isAllowedCimdClientId(CLAUDE_CIMD), true);
  assert.equal(isAllowedCimdClientId(CLAUDE_COM_CIMD), true);
  assert.equal(isAllowedCimdClientId(CODEX_CIMD), true);
  assert.equal(isAllowedCimdClientId(CODEX_STABLE), true);
  assert.equal(isAllowedCimdClientId(CHATGPT_CIMD), true);
  assert.equal(isAllowedCimdClientId(HERMES_CIMD), true);
});

test("CIMD allowlist rejects other hosts, ports, queries, and non-public documents", () => {
  assert.equal(
    isAllowedCimdClientId("https://chatgpt.com/oauth/evil/nested/client.json"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId("https://evil.example/oauth/codex/client.json"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId("http://chatgpt.com/oauth/codex/client.json"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId("https://chatgpt.com/oauth/codex/client.json?x=1"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId("https://chatgpt.com/oauth/codex/client.json#x"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId("https://user@chatgpt.com/oauth/codex/client.json"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId("https://chatgpt.com:8443/oauth/codex/client.json"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId("https://CHATGPT.com/oauth/codex/client.json"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId("https://claude.ai/oauth/mcp-oauth-client-metadata/"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId("https://gist.githubusercontent.com/u/1/raw/client.json"),
    false,
  );
  assert.equal(
    isAllowedCimdClientId(
      "https://nousresearch.github.io/hermes-agent/docs/oauth/other.json",
    ),
    false,
  );
  assert.equal(
    isAllowedCimdClientId(
      "https://cursor.com/oauth/mcp-oauth-client-metadata",
    ),
    false,
  );
});

test("resolveCimdClient does not fetch URLs outside the allowlist", async () => {
  const result = await resolveCimdClient(
    "https://gist.githubusercontent.com/u/1/raw/client.json",
    async () => {
      throw new Error("should not fetch");
    },
  );
  assert.deepEqual(result, { ok: false, error: "invalid_client" });
});

test("resolveCimdClient accepts Codex loopback metadata", async () => {
  clearCimdCache();
  const result = await resolveCimdClient(CODEX_CIMD, async () =>
    jsonResponse({
      client_id: CODEX_CIMD,
      redirect_uris: ["http://127.0.0.1/callback/BKj9umzr4ef_"],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.client.redirectUris, [
      "http://127.0.0.1/callback/BKj9umzr4ef_",
    ]);
  }
});

test("resolveCimdClient accepts Hermes loopback metadata", async () => {
  clearCimdCache();
  const result = await resolveCimdClient(HERMES_CIMD, async () =>
    jsonResponse({
      client_id: HERMES_CIMD,
      redirect_uris: HERMES_REDIRECTS,
      token_endpoint_auth_method: "none",
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.client.redirectUris, HERMES_REDIRECTS);
  }
});

test("resolveCimdClient accepts ChatGPT connector redirects", async () => {
  clearCimdCache();
  const result = await resolveCimdClient(CHATGPT_CIMD, async () =>
    jsonResponse({
      client_id: CHATGPT_CIMD,
      redirect_uris: ["https://chatgpt.com/connector/oauth/BKj9umzr4ef_"],
      token_endpoint_auth_method: "none",
    }),
  );
  assert.equal(result.ok, true);
});

test("resolveCimdClient accepts Claude metadata", async () => {
  clearCimdCache();
  const result = await resolveCimdClient(CLAUDE_CIMD, async () =>
    jsonResponse({
      client_id: CLAUDE_CIMD,
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );
  assert.equal(result.ok, true);
});

test("resolveCimdClient refuses private-only clients and evil redirects", async () => {
  clearCimdCache();
  const jwtOnly = await resolveCimdClient(CODEX_STABLE, async () =>
    jsonResponse({
      client_id: CODEX_STABLE,
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
    }),
  );
  assert.deepEqual(jwtOnly, { ok: false, error: "invalid_client" });

  clearCimdCache();
  const evil = await resolveCimdClient(CODEX_STABLE, async () =>
    jsonResponse({
      client_id: CODEX_STABLE,
      redirect_uris: ["https://evil.example/callback"],
    }),
  );
  assert.deepEqual(evil, { ok: false, error: "invalid_client" });
});

test("resolveCimdClient refuses client_id mismatches, non-JSON, and fetch failures", async () => {
  clearCimdCache();
  const mismatch = await resolveCimdClient(CODEX_STABLE, async () =>
    jsonResponse({
      client_id: "https://chatgpt.com/oauth/other/client.json",
      redirect_uris: ["http://127.0.0.1/callback"],
    }),
  );
  assert.deepEqual(mismatch, { ok: false, error: "invalid_client" });

  clearCimdCache();
  const html = await resolveCimdClient(
    CODEX_STABLE,
    async () =>
      new Response("<html>nope</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  );
  assert.deepEqual(html, { ok: false, error: "invalid_client" });

  clearCimdCache();
  const down = await resolveCimdClient(CODEX_STABLE, async () => {
    throw new Error("network");
  });
  assert.deepEqual(down, { ok: false, error: "temporarily_unavailable" });

  clearCimdCache();
  const serverError = await resolveCimdClient(CODEX_STABLE, async () =>
    jsonResponse({ error: "down" }, 502),
  );
  assert.deepEqual(serverError, {
    ok: false,
    error: "temporarily_unavailable",
  });
});

test("resolveCimdClient does not cache 4xx responses", async () => {
  clearCimdCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: "not ready" }, 404);
    return jsonResponse({
      client_id: CODEX_STABLE,
      redirect_uris: ["http://127.0.0.1/callback"],
    });
  };
  assert.deepEqual(await resolveCimdClient(CODEX_STABLE, fetchImpl), {
    ok: false,
    error: "invalid_client",
  });
  assert.equal((await resolveCimdClient(CODEX_STABLE, fetchImpl)).ok, true);
  assert.equal(calls, 2);
});

test("resolveCimdClient cancels a body once it exceeds the byte limit", async () => {
  clearCimdCache();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(9000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await resolveCimdClient(
    CODEX_STABLE,
    async () => new Response(body, { status: 200 }),
  );
  assert.deepEqual(result, { ok: false, error: "invalid_client" });
  assert.equal(cancelled, true);
});

test("resolveCimdClient bounds concurrent metadata fetches", async () => {
  clearCimdCache();
  const releases: Array<(response: Response) => void> = [];
  const fetchImpl: typeof fetch = async () =>
    new Promise<Response>((resolve) => {
      releases.push((response) => resolve(response));
    });

  const requests = Array.from({ length: 8 }, (_, index) =>
    resolveCimdClient(
      `https://chatgpt.com/oauth/codex/id${index}/client.json`,
      fetchImpl,
    ),
  );
  await Promise.resolve();
  assert.deepEqual(
    await resolveCimdClient(
      "https://chatgpt.com/oauth/codex/overflow/client.json",
      fetchImpl,
    ),
    { ok: false, error: "temporarily_unavailable" },
  );

  releases.forEach((release, index) => {
    const clientId = `https://chatgpt.com/oauth/codex/id${index}/client.json`;
    release(
      jsonResponse({
        client_id: clientId,
        redirect_uris: [`http://127.0.0.1/callback/id${index}`],
      }),
    );
  });
  const results = await Promise.all(requests);
  assert.equal(
    results.every((result) => result.ok),
    true,
  );
});

test("resolveCimdClient caches a successful document", async () => {
  clearCimdCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({
      client_id: CODEX_STABLE,
      redirect_uris: ["http://127.0.0.1/callback"],
    });
  };
  await resolveCimdClient(CODEX_STABLE, fetchImpl);
  await resolveCimdClient(CODEX_STABLE, fetchImpl);
  assert.equal(calls, 1);
});
