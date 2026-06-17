import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { run } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys } from "@/db/schema";
import { hashToken } from "@/lib/auth";

/** Insert an active, subscription-less API key for `clientId`; returns the token. */
async function seedActiveApiKey(clientId: string, userId: string): Promise<string> {
  const token = `pmth_test_${randomUUID()}`;
  await db.insert(apiKeys).values({
    id: `key-${randomUUID()}`,
    keyHash: hashToken(token),
    clientId,
    userId,
    label: "PYMT-3 test key",
    status: "active",
  });
  return token;
}

function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.BPP_VALIDATE_V2;
  if (value === undefined) {
    delete process.env.BPP_VALIDATE_V2;
  } else {
    process.env.BPP_VALIDATE_V2 = value;
  }
  return fn().finally(() => {
    if (prior === undefined) {
      delete process.env.BPP_VALIDATE_V2;
    } else {
      process.env.BPP_VALIDATE_V2 = prior;
    }
  });
}

// ---- flag gating (no DB required) ----------------------------------------

test("POST validate is a no-op 404 when BPP_VALIDATE_V2 is OFF (zero regression)", async () => {
  const { POST } = await import("./route");
  await withFlag(undefined, async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/auth/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "pmth_whatever" }),
      }) as never,
    );
    assert.equal(res.status, 404);
  });
});

test("POST validate rejects a missing key with 400 when enabled", async () => {
  const { POST } = await import("./route");
  await withFlag("1", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/auth/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }) as never,
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { valid: false });
  });
});

// ---- DB-backed back-compat + C0 conformance ------------------------------

run("legacy GET validate is unchanged (back-compat): client_id + allowedModels", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));
  const token = await seedActiveApiKey(app.clientId, app.userId);

  const res = await GET(
    new Request("http://localhost/api/v1/auth/validate", {
      headers: { Authorization: `Bearer ${token}` },
    }) as never,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.valid, true);
  // Legacy neutral fields preserved verbatim for current consumers.
  assert.equal(body.client_id, app.clientId);
  assert.equal(body.plan, null);
  assert.deepEqual(body.allowedModels, []);
  // Legacy path does NOT expose the reshaped C0 fields.
  assert.ok(!("user" in body));
  assert.ok(!("billing_account" in body));
});

run("POST validate returns the C0-conformant reshaped body for a valid key", async (t) => {
  const { POST } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));
  const token = await seedActiveApiKey(app.clientId, app.userId);

  await withFlag("1", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/auth/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: token }),
      }) as never,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(body.valid, true);
    assert.deepEqual(body.user, { sub: app.userId });
    assert.deepEqual(body.billing_account, {
      id: app.clientId,
      providerSlug: "pymthouse",
      billingMode: "delegated",
    });
    assert.deepEqual(body.capabilities, ["*"]); // delegated MVP — all
    assert.equal(body.quota, null);

    // The ⑨ forbidden public client_id (and the legacy shape) must be gone.
    assert.ok(!("client_id" in body), "client_id must not leak");
    assert.ok(!("allowedModels" in body), "allowedModels must be reshaped");
    assert.ok(!("plan" in body), "plan is not part of the C0 ② contract");
    assert.ok(!("openmeter_subscription_id" in body));
  });
});

run("POST validate rejects an unknown key with 401", async () => {
  const { POST } = await import("./route");
  await withFlag("1", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/auth/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "pmth_does_not_exist" }),
      }) as never,
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { valid: false });
  });
});
