import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";

import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { discoveryProfiles, plans } from "@/db/schema";
import { run } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";

let authorizedApp: SeededDeveloperApp | null = null;

type ModuleLoad = (
  request: string,
  parent: NodeJS.Module | null | undefined,
  isMain: boolean,
) => unknown;

const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = (request, parent, isMain) => {
  if (request === "next-auth") {
    return {
      getServerSession: async () =>
        authorizedApp
          ? {
              user: {
                id: authorizedApp.userId,
                role: "developer",
              },
            }
          : null,
    };
  }
  return originalLoad(request, parent, isMain);
};

async function postPlan(clientId: string, body: Record<string, unknown>) {
  const { POST } = await import("./route");
  const res = await POST(
    new Request(`http://localhost/api/v1/apps/${clientId}/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: clientId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

run("plans POST validates subscription billing fields before creating a plan", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(() => {
    authorizedApp = null;
    return cleanupTestApp(app);
  });

  const missingBilling = await postPlan(app.clientId, {
    name: "Subscription without quota",
    type: "subscription",
    priceAmount: "20",
    priceCurrency: "USD",
  });
  assert.equal(missingBilling.status, 400);
  assert.equal(
    missingBilling.body.error,
    "includedUnits and overageRateWei are required for subscription plans",
  );

  const valid = await postPlan(app.clientId, {
    name: "Subscription with quota",
    type: "subscription",
    priceAmount: "20",
    priceCurrency: "USD",
    includedUnits: "1000000",
    overageRateWei: "25",
    includedUsdMicros: "20000000",
    generalUpchargePercentBps: 2000,
  });
  assert.equal(valid.status, 201);
  assert.equal(typeof valid.body.id, "string");

  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, valid.body.id as string))
    .limit(1);
  assert.equal(planRows.length, 1);
  assert.equal(planRows[0].clientId, app.clientId);
  assert.equal(planRows[0].type, "subscription");
  assert.equal(planRows[0].includedUnits?.toString(), "1000000");
  assert.equal(planRows[0].overageRateWei?.toString(), "25");
  assert.equal(planRows[0].includedUsdMicros, "20000000");
  assert.equal(planRows[0].generalUpchargePercentBps, 2000);
});

run("plans POST validates capabilities and discovery policy payloads", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(() => {
    authorizedApp = null;
    return cleanupTestApp(app);
  });

  const nonArrayCapabilities = await postPlan(app.clientId, {
    name: "Bad capabilities",
    type: "free",
    capabilities: { pipeline: "text-to-image", modelId: "*" },
  });
  assert.equal(nonArrayCapabilities.status, 400);
  assert.equal(nonArrayCapabilities.body.error, "capabilities must be an array");

  const missingPipeline = await postPlan(app.clientId, {
    name: "Missing capability pipeline",
    type: "free",
    capabilities: [{ modelId: "*" }],
  });
  assert.equal(missingPipeline.status, 400);
  assert.equal(missingPipeline.body.error, "capabilities[0].pipeline is required");

  const invalidProfile = await postPlan(app.clientId, {
    name: "Invalid profile ref",
    type: "free",
    discoveryProfileId: randomUUID(),
  });
  assert.equal(invalidProfile.status, 400);
  assert.equal(
    typeof invalidProfile.body.error === "string" &&
      invalidProfile.body.error.includes("discoveryProfileId"),
    true,
  );

  const profileId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(discoveryProfiles).values({
    id: profileId,
    clientId: app.clientId,
    name: "For plan test",
    policy: { topN: 5 },
    createdAt: now,
    updatedAt: now,
  });

  const withProfile = await postPlan(app.clientId, {
    name: "Plan with profile",
    type: "free",
    discoveryProfileId: profileId,
  });
  assert.equal(withProfile.status, 201);
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, withProfile.body.id as string))
    .limit(1);
  assert.equal(planRows[0]?.discoveryProfileId, profileId);
});
