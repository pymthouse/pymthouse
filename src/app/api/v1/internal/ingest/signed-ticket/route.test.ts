import test from "node:test";
import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import { run } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";
import {
  __testClearOpenMeterUsageStubs,
  queryOpenMeterUsage,
} from "@/lib/openmeter/usage-read";
import { withEnv } from "@/test-utils/env";

const URL_PATH = "http://localhost/api/v1/internal/ingest/signed-ticket";

function ingestRequest(input: {
  body: unknown;
  bearer?: string;
}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.bearer !== undefined) {
    headers.authorization = `Bearer ${input.bearer}`;
  }
  return new NextRequest(URL_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(input.body),
  });
}

function signedTicketBody(input: {
  clientId: string;
  externalUserId: string;
  requestId: string;
  computedFeeUsdMicros?: string;
}) {
  return {
    type: "create_signed_ticket",
    data: {
      client_id: input.clientId,
      usage_subject: input.externalUserId,
      request_id: input.requestId,
      computed_fee_usd_micros: input.computedFeeUsdMicros ?? "547000",
      pipeline: "live-video-to-video",
      model_id: "streamdiffusion",
    },
  };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

test("ingest rejects callers without the configured shared secret", async () => {
  await withEnv({ INGEST_SHARED_SECRET: "s3cr3t" }, async () => {
    const { POST } = await import("./route");

    const noAuth = await POST(
      ingestRequest({
        body: signedTicketBody({
          clientId: "app_x",
          externalUserId: "u",
          requestId: "r",
        }),
      }),
    );
    assert.equal(noAuth.status, 401);

    const wrong = await POST(
      ingestRequest({
        bearer: "nope",
        body: signedTicketBody({
          clientId: "app_x",
          externalUserId: "u",
          requestId: "r",
        }),
      }),
    );
    assert.equal(wrong.status, 401);
  });
});

test("ingest rejects unsupported event types", async () => {
  await withEnv({ INGEST_SHARED_SECRET: undefined }, async () => {
    const { POST } = await import("./route");
    const res = await POST(
      ingestRequest({ body: { type: "something_else", data: {} } }),
    );
    assert.equal(res.status, 400);
  });
});

test("ingest rejects invalid JSON", async () => {
  await withEnv({ INGEST_SHARED_SECRET: undefined }, async () => {
    const { POST } = await import("./route");
    const req = new NextRequest(URL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
  });
});

test("durable path rejects an event with no usable fee (flag ON)", async () => {
  await withEnv(
    { INGEST_SHARED_SECRET: undefined, SIGNED_TICKET_DURABLE_INGEST: "1" },
    async () => {
      const { POST } = await import("./route");
      const res = await POST(
        ingestRequest({
          body: {
            type: "create_signed_ticket",
            data: {
              client_id: "app_x",
              usage_subject: "u",
              request_id: "r",
            },
          },
        }),
      );
      assert.equal(res.status, 400);
    },
  );
});

run("flag OFF is zero-regression: diagnostic receipt, no OpenMeter write", async (t) => {
  await withEnv(
    { INGEST_SHARED_SECRET: undefined, SIGNED_TICKET_DURABLE_INGEST: undefined },
    async () => {
      const { POST } = await import("./route");
      const app = await seedDeveloperAppWithClient({ status: "approved" });
      t.after(() => cleanupTestApp(app));
      t.after(() => __testClearOpenMeterUsageStubs());

      const res = await POST(
        ingestRequest({
          body: signedTicketBody({
            clientId: app.clientId,
            externalUserId: "naap-storyboard-preview",
            requestId: "req-off-1",
          }),
        }),
      );
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.equal(body.diagnostic, true);
      assert.equal(body.ingested, false);
      assert.equal(body.duplicate, false);

      // OpenMeter must NOT have been written on the legacy/diagnostic path.
      const rows = await queryOpenMeterUsage({ clientId: app.clientId });
      const total = rows.reduce((sum, row) => sum + row.requestCount, 0);
      assert.equal(total, 0);
    },
  );
});

run("flag ON: driving N events yields an OpenMeter delta of exactly N", async (t) => {
  await withEnv(
    { INGEST_SHARED_SECRET: undefined, SIGNED_TICKET_DURABLE_INGEST: "1" },
    async () => {
      const { POST } = await import("./route");
      const app = await seedDeveloperAppWithClient({ status: "approved" });
      t.after(() => cleanupTestApp(app));
      t.after(() => __testClearOpenMeterUsageStubs());

      const n = 5;
      for (let i = 0; i < n; i++) {
        const res = await POST(
          ingestRequest({
            body: signedTicketBody({
              clientId: app.clientId,
              externalUserId: "naap-storyboard-preview",
              requestId: `req-on-${i}`,
            }),
          }),
        );
        assert.equal(res.status, 200);
        const body = await readJson(res);
        assert.equal(body.ingested, true);
        assert.equal(body.duplicate, false);
      }

      const rows = await queryOpenMeterUsage({ clientId: app.clientId });
      const total = rows.reduce((sum, row) => sum + row.requestCount, 0);
      assert.equal(total, n);
    },
  );
});

run("flag ON: a duplicate (clientId, requestId) meters exactly once", async (t) => {
  await withEnv(
    { INGEST_SHARED_SECRET: undefined, SIGNED_TICKET_DURABLE_INGEST: "1" },
    async () => {
      const { POST } = await import("./route");
      const app = await seedDeveloperAppWithClient({ status: "approved" });
      t.after(() => cleanupTestApp(app));
      t.after(() => __testClearOpenMeterUsageStubs());

      const body = signedTicketBody({
        clientId: app.clientId,
        externalUserId: "naap-storyboard-preview",
        requestId: "req-dupe-1",
      });

      const first = await POST(ingestRequest({ body }));
      assert.equal(first.status, 200);
      assert.equal((await readJson(first)).duplicate, false);

      const second = await POST(ingestRequest({ body }));
      assert.equal(second.status, 200);
      assert.equal((await readJson(second)).duplicate, true);

      const rows = await queryOpenMeterUsage({ clientId: app.clientId });
      const total = rows.reduce((sum, row) => sum + row.requestCount, 0);
      assert.equal(total, 1);
    },
  );
});

run("flag ON: unknown client_id returns 404", async (t) => {
  await withEnv(
    { INGEST_SHARED_SECRET: undefined, SIGNED_TICKET_DURABLE_INGEST: "1" },
    async () => {
      const { POST } = await import("./route");
      t.after(() => __testClearOpenMeterUsageStubs());

      const res = await POST(
        ingestRequest({
          body: signedTicketBody({
            clientId: "app_does_not_exist_zzz",
            externalUserId: "u",
            requestId: "req-404",
          }),
        }),
      );
      assert.equal(res.status, 404);
    },
  );
});
