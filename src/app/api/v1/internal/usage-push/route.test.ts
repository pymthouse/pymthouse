import test from "node:test";
import assert from "node:assert/strict";

import { NextRequest } from "next/server";

const CRON_SECRET = "cron-secret-value";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> | void {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const k of keys) {
      const prev = previous.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function cronRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest("http://localhost/api/v1/internal/usage-push", { headers });
}

test("usage-push cron rejects callers without the configured secret", async () => {
  await withEnv(
    { USAGE_PUSH_CRON_SECRET: CRON_SECRET, CRON_SECRET: undefined, USAGE_INGEST_PUSH: undefined },
    async () => {
      const { GET } = await import("./route");

      const noAuth = await GET(cronRequest());
      assert.equal(noAuth.status, 401);

      const wrong = await GET(cronRequest("nope"));
      assert.equal(wrong.status, 401);
    },
  );
});

test("usage-push cron is an inert no-op when USAGE_INGEST_PUSH is OFF", async () => {
  await withEnv(
    { USAGE_PUSH_CRON_SECRET: CRON_SECRET, CRON_SECRET: undefined, USAGE_INGEST_PUSH: undefined },
    async () => {
      const { GET } = await import("./route");

      const res = await GET(cronRequest(CRON_SECRET));
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.enabled, false);
      assert.equal(body.attempted, 0);
      assert.equal(body.window, null);
    },
  );
});
