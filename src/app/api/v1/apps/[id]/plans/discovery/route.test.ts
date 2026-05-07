import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { run } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

run("plans discovery GET allows M2M for own app and returns active plans", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const { db } = await import("@/db/index");
  const { plans, planCapabilityBundles, discoveryProfiles, discoveryProfileBundles } =
    await import("@/db/schema");
  const profileId = randomUUID();
  const planId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(discoveryProfiles).values({
    id: profileId,
    clientId: app.clientId,
    name: "Discovery test profile",
    policy: { topN: 7, sortBy: "latency" },
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(discoveryProfileBundles).values({
    id: randomUUID(),
    profileId,
    clientId: app.clientId,
    pipeline: "llm",
    modelId: "*",
    discoveryPolicy: { topN: 3 },
    createdAt: now,
  });
  await db.insert(plans).values({
    id: planId,
    clientId: app.clientId,
    name: "Discovery test plan",
    type: "free",
    status: "active",
    discoveryProfileId: profileId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(planCapabilityBundles).values({
    id: randomUUID(),
    planId,
    clientId: app.clientId,
    pipeline: "llm",
    modelId: "*",
    createdAt: now,
  });

  const res = await GET(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/plans/discovery`, {
      headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
    }) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    plans: Array<{
      id: string;
      discoveryPolicy: { topN?: number } | null;
      capabilities: Array<{ pipeline: string; modelId: string; discoveryPolicy: { topN?: number } | null }>;
    }>;
  };
  const row = body.plans.find((p) => p.id === planId);
  assert.ok(row);
  assert.equal(row?.capabilities.length, 1);
  assert.equal(row?.discoveryPolicy?.topN, 7);
  assert.equal(row?.capabilities[0]?.modelId, "*");
  assert.equal(row?.capabilities[0]?.discoveryPolicy?.topN, 3);
});

run("plans discovery GET denies M2M for another app id", async (t) => {
  const { GET } = await import("./route");
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  const other = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => {
    cleanupTestApp(app);
    cleanupTestApp(other);
  });

  const res = await GET(
    new Request(`http://localhost/api/v1/apps/${other.clientId}/plans/discovery`, {
      headers: { Authorization: basicAuthHeader(app.clientId, app.clientSecret) },
    }) as never,
    { params: Promise.resolve({ id: other.clientId }) },
  );
  assert.equal(res.status, 404);
});
