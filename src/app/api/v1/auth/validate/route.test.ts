import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { OpenMeter } from "@openmeter/sdk";
import { NextRequest } from "next/server";

import { run } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";
import { db } from "@/db/index";
import { apiKeys, planCapabilityBundles, plans, subscriptions } from "@/db/schema";
import { hashToken } from "@/lib/auth";
import { __setValidateAdminClientForTests } from "@/lib/openmeter/validate-admin-client";
import { subscriptionRefMatches } from "@/lib/bpp/subscription-ref";

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

run(
  "subscription-backed legacy GET /auth/validate emits neutral subscriptionRef (no openmeter_subscription_id)",
  async (t) => {
    const { GET } = await import("./route");

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

    __setValidateAdminClientForTests(() => ({
      available: true,
      client: fakeActiveSubscriptionClient(),
    }));
    t.after(() => __setValidateAdminClientForTests(null));

    const res = await GET(
      new NextRequest("http://localhost/api/v1/auth/validate", {
        headers: { Authorization: `Bearer ${rawToken}` },
      }),
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(body.valid, true);
    assert.equal(body.client_id, app.clientId);

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
  },
);
