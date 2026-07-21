import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { OpenMeter } from "@openmeter/sdk";
import { NextRequest } from "next/server";

import { test } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys, planCapabilityBundles, plans, subscriptions } from "@/db/schema";
import { hashToken } from "@/lib/auth";
import { __setValidateAdminClientForTests } from "@/lib/openmeter/validate-admin-client";
import { subscriptionRefMatches } from "@/lib/bpp/subscription-ref";

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

/** Raw provider-internal OpenMeter subscription id that must NOT cross the ② seam. */
const OPENMETER_SUBSCRIPTION_ULID = "01J8ZQ9X7K6M3N2P4R5S6T7U8V";

/** Fake OpenMeter admin client: only `subscriptions.get` is exercised by validate. */
function fakeActiveSubscriptionClient(): OpenMeter {
  return {
    subscriptions: {
      get: async (id: string) => ({ id, status: "active" }),
    },
  } as unknown as OpenMeter;
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

// ---- DB-backed C0 conformance --------------------------------------------

test("POST validate returns the C0-conformant reshaped body for a valid key", async (t) => {
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

test("POST validate rejects an unknown key with 401", async () => {
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

test(
  "subscription-backed POST /auth/validate emits neutral subscriptionRef (no openmeter id leak)",
  async (t) => {
    const { POST } = await import("./route");

    const app = await seedDeveloperAppWithClient({ status: "approved" });
    t.after(() => cleanupTestApp(app));

    // Plan + capability the subscription-backed key resolves to.
    const planId = `plan-${randomUUID()}`;
    await db.insert(plans).values({
      id: planId,
      clientId: app.clientId,
      name: `Validate Test Plan ${randomUUID().slice(0, 8)}`,
      type: "paid",
      status: "active",
    });
    await db.insert(planCapabilityBundles).values({
      id: `pcb-${randomUUID()}`,
      planId,
      clientId: app.clientId,
      pipeline: "text-to-image",
      modelId: "sdxl",
    });

    // Legacy local subscription row carrying the OpenMeter pointer + plan.
    const subscriptionId = `sub-${randomUUID()}`;
    await db.insert(subscriptions).values({
      id: subscriptionId,
      clientId: app.clientId,
      planId,
      status: "active",
      openmeterSubscriptionId: OPENMETER_SUBSCRIPTION_ULID,
    });

    // Subscription-backed API key (resolves through the OpenMeter branch).
    const rawToken = `pmth_test_${randomUUID()}`;
    await db.insert(apiKeys).values({
      id: `key-${randomUUID()}`,
      keyHash: hashToken(rawToken),
      clientId: app.clientId,
      subscriptionId,
      status: "active",
    });

    // Drive the subscription branch through the shared injection seam — proving
    // the POST handler now honors `resolveValidateAdminClient()` (review #1).
    __setValidateAdminClientForTests(() => ({
      available: true,
      client: fakeActiveSubscriptionClient(),
    }));
    t.after(() => __setValidateAdminClientForTests(null));

    await withFlag("1", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/auth/validate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: rawToken }),
        }),
      );

      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;

      assert.equal(body.valid, true);
      // C0 capabilities are reshaped from the plan's bundles (pipeline:model).
      assert.deepEqual(body.capabilities, ["text-to-image:sdxl"]);

      // The neutral, opaque subscriptionRef is surfaced...
      assert.equal(typeof body.subscriptionRef, "string");
      const ref = body.subscriptionRef as string;
      assert.match(ref, /^subref_/);
      // ...it is NOT reversible to the raw OpenMeter id (true opacity)...
      assert.notEqual(
        Buffer.from(ref.slice("subref_".length), "base64url").toString("utf8"),
        OPENMETER_SUBSCRIPTION_ULID,
      );
      // ...but pymthouse can still verify it against the known internal id.
      assert.equal(subscriptionRefMatches(ref, OPENMETER_SUBSCRIPTION_ULID), true);

      // The provider-internal identifier never leaks — neither as a key...
      assert.ok(!("openmeter_subscription_id" in body));
      for (const key of Object.keys(body)) {
        assert.ok(
          !key.toLowerCase().startsWith("openmeter"),
          `unexpected openmeter* key leaked: ${key}`,
        );
      }
      // ...nor as a raw value anywhere in the response.
      assert.ok(!JSON.stringify(body).includes(OPENMETER_SUBSCRIPTION_ULID));
    });
  },
);
