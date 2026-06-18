import test from "node:test";
import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import { withEnv } from "@/test-utils/env";

const CRON_SECRET = "cron-secret-value";

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
