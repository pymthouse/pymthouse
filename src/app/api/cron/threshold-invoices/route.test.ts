import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

test("threshold-invoices cron rejects missing or wrong bearer secret", async (t) => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron_test_secret";
  t.after(() => {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  const { GET } = await import("./route");

  const missing = await GET(
    new NextRequest("http://localhost/api/cron/threshold-invoices"),
  );
  assert.equal(missing.status, 401);

  const wrong = await GET(
    new NextRequest("http://localhost/api/cron/threshold-invoices", {
      headers: { authorization: "Bearer nope" },
    }),
  );
  assert.equal(wrong.status, 401);
});

test("threshold-invoices cron rejects when CRON_SECRET is unset", async (t) => {
  const prev = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  t.after(() => {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  const { GET } = await import("./route");
  const res = await GET(
    new NextRequest("http://localhost/api/cron/threshold-invoices", {
      headers: { authorization: "Bearer anything" },
    }),
  );
  assert.equal(res.status, 401);
});

test("threshold-invoices cron runs sweep with valid bearer", async (t) => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron_test_secret";
  t.after(() => {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  const { GET, POST } = await import("./route");
  const req = new NextRequest("http://localhost/api/cron/threshold-invoices", {
    headers: { authorization: "Bearer cron_test_secret" },
  });
  const getRes = await GET(req);
  assert.equal(getRes.status, 200);
  const body = (await getRes.json()) as { ok: boolean };
  assert.equal(body.ok, true);

  const postRes = await POST(req);
  assert.equal(postRes.status, 200);
});
