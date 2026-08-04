import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";

import {
  buildOwnerAllowancePlanBody,
  createOwnerAllowancePlan,
  findOpenMeterPlanByKey,
  openMeterPlanNeedsPublish,
  parseOwnerAllowanceIncludedMicros,
  publishOpenMeterPlanBestEffort,
} from "@/lib/openmeter/owner-allowance-plan";
import { DEFAULT_TRIAL_FEATURE_KEY } from "@/lib/openmeter/constants";

test("parseOwnerAllowanceIncludedMicros floors valid amounts and defaults invalid", () => {
  assert.equal(parseOwnerAllowanceIncludedMicros("5000000"), 5_000_000);
  assert.equal(parseOwnerAllowanceIncludedMicros("5000000.9"), 5_000_000);
  assert.equal(parseOwnerAllowanceIncludedMicros("0"), 5_000_000);
  assert.equal(parseOwnerAllowanceIncludedMicros("-1"), 5_000_000);
  assert.equal(parseOwnerAllowanceIncludedMicros("nope"), 5_000_000);
});

test("openMeterPlanNeedsPublish only for draft/scheduled", () => {
  assert.equal(openMeterPlanNeedsPublish("draft"), true);
  assert.equal(openMeterPlanNeedsPublish("scheduled"), true);
  assert.equal(openMeterPlanNeedsPublish("active"), false);
  assert.equal(openMeterPlanNeedsPublish(undefined), false);
});

test("buildOwnerAllowancePlanBody sets kind metadata and rate card", () => {
  const body = buildOwnerAllowancePlanBody({
    planKey: "pymthouse_owner_paid",
    planName: "Owner Paid",
    planKind: "owner_paid",
    featureId: "feat_1",
    includedUsdMicros: 5_000_000,
    unitAmount: "0.000001",
  });
  assert.equal(body.key, "pymthouse_owner_paid");
  assert.equal(body.name, "Owner Paid");
  assert.equal(
    (body.metadata as { pymthouse_plan_kind: string }).pymthouse_plan_kind,
    "owner_paid",
  );
  const phases = body.phases as Array<{
    rate_cards: Array<{ key: string; feature: { id: string } }>;
  }>;
  assert.equal(phases[0]?.rate_cards[0]?.key, DEFAULT_TRIAL_FEATURE_KEY);
  assert.equal(phases[0]?.rate_cards[0]?.feature.id, "feat_1");
});

test("findOpenMeterPlanByKey returns exact list match", async () => {
  const client = {
    plans: {
      list: async () => ({
        items: [{ id: "plan_1", key: "k1", status: "active" }],
      }),
      get: async () => {
        throw new Error("should not get");
      },
    },
  } as unknown as OpenMeter;

  const found = await findOpenMeterPlanByKey(client, "k1");
  assert.equal(found?.id, "plan_1");
});

test("findOpenMeterPlanByKey falls back to get when list misses", async () => {
  const client = {
    plans: {
      list: async () => ({ items: [] }),
      get: async () => ({
        id: "plan_2",
        key: "k2",
        version: 3,
        status: "draft",
      }),
    },
  } as unknown as OpenMeter;

  const found = await findOpenMeterPlanByKey(client, "k2");
  assert.deepEqual(found, {
    id: "plan_2",
    key: "k2",
    version: 3,
    status: "draft",
  });
});

test("findOpenMeterPlanByKey returns null when both lookups fail", async () => {
  const client = {
    plans: {
      list: async () => {
        throw new Error("list failed");
      },
      get: async () => {
        throw new Error("get failed");
      },
    },
  } as unknown as OpenMeter;

  assert.equal(await findOpenMeterPlanByKey(client, "missing"), null);
});

test("publishOpenMeterPlanBestEffort returns published id", async () => {
  const client = {
    plans: {
      publish: async () => ({ id: "published_1" }),
    },
  } as unknown as OpenMeter;

  assert.equal(
    await publishOpenMeterPlanBestEffort(client, "draft_1", "owner paid"),
    "published_1",
  );
});

test("publishOpenMeterPlanBestEffort keeps plan id on conflict", async () => {
  const client = {
    plans: {
      publish: async () => {
        const err = new Error("conflict error: already published");
        throw err;
      },
    },
  } as unknown as OpenMeter;

  assert.equal(
    await publishOpenMeterPlanBestEffort(client, "plan_keep", "owner starter"),
    "plan_keep",
  );
});

test("createOwnerAllowancePlan returns created id", async () => {
  const client = {
    plans: {
      create: async () => ({ id: "created_1" }),
      list: async () => ({ items: [] }),
      get: async () => null,
    },
  } as unknown as OpenMeter;

  const id = await createOwnerAllowancePlan({
    client,
    planKey: "pymthouse_owner_paid",
    planName: "Owner Paid",
    planKind: "owner_paid",
    featureId: "feat_1",
    includedUsdMicros: "5000000",
    createFailedMessage: "Failed to create Owner Paid plan",
  });
  assert.equal(id, "created_1");
});

test("createOwnerAllowancePlan recovers raced create via find", async () => {
  const client = {
    plans: {
      create: async () => {
        throw new Error("conflict error: already exists");
      },
      list: async () => ({
        items: [{ id: "raced_1", key: "pymthouse_owner_paid" }],
      }),
      get: async () => null,
    },
  } as unknown as OpenMeter;

  const id = await createOwnerAllowancePlan({
    client,
    planKey: "pymthouse_owner_paid",
    planName: "Owner Paid",
    planKind: "owner_paid",
    featureId: "feat_1",
    includedUsdMicros: "5000000",
    createFailedMessage: "Failed to create Owner Paid plan",
  });
  assert.equal(id, "raced_1");
});
