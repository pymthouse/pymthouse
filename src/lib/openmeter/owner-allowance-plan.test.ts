import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";

import {
  buildOwnerAllowancePlanBody,
  createOwnerAllowancePlan,
  findOpenMeterPlanByKey,
  forceSyncOwnerAllowancePlanWithClient,
  openMeterPlanNeedsPublish,
  parseOwnerAllowanceIncludedMicros,
  publishOpenMeterPlanBestEffort,
  readUsageDiscountUsdMicrosFromPlanBody,
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
    rate_cards: Array<{ key: string; feature?: { id: string }; price?: { type: string } }>;
  }>;
  assert.equal(phases[0]?.rate_cards.length, 1);
  assert.equal(phases[0]?.rate_cards[0]?.key, DEFAULT_TRIAL_FEATURE_KEY);
});

test("buildOwnerAllowancePlanBody prepends flat fee for paid tiers", () => {
  const body = buildOwnerAllowancePlanBody({
    planKey: "pymthouse_owner_paid_growth",
    planName: "Growth",
    planKind: "owner_paid_tier",
    featureId: "feat_1",
    includedUsdMicros: 10_000_000,
    unitAmount: "0.000001",
    monthlyFeeUsd: "29.00",
    tierId: "tier_1",
  });
  const phases = body.phases as Array<{
    rate_cards: Array<{ key: string; price?: { type: string; amount?: string } }>;
  }>;
  assert.equal(phases[0]?.rate_cards.length, 2);
  assert.equal(phases[0]?.rate_cards[0]?.key, "subscription_fee");
  assert.equal(phases[0]?.rate_cards[0]?.price?.type, "flat");
  assert.equal(phases[0]?.rate_cards[0]?.price?.amount, "29.00");
  assert.equal(phases[0]?.rate_cards[1]?.key, DEFAULT_TRIAL_FEATURE_KEY);
  assert.equal(
    (body.metadata as { tier_id?: string }).tier_id,
    "tier_1",
  );
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

test("readUsageDiscountUsdMicrosFromPlanBody reads snake_case and camelCase", () => {
  assert.equal(
    readUsageDiscountUsdMicrosFromPlanBody({
      phases: [{ rate_cards: [{ discounts: { usage: 5_000_000 } }] }],
    }),
    "5000000",
  );
  assert.equal(
    readUsageDiscountUsdMicrosFromPlanBody({
      phases: [{ rateCards: [{ discounts: { usage: "7500000" } }] }],
    }),
    "7500000",
  );
  assert.equal(readUsageDiscountUsdMicrosFromPlanBody({}), null);
});

test("forceSyncOwnerAllowancePlanWithClient updates an existing plan", async () => {
  const updatedIds: string[] = [];
  const client = {
    plans: {
      list: async () => ({
        items: [{ id: "plan_old", key: "pymthouse_owner_paid", status: "draft" }],
      }),
      get: async () => null,
      update: async (id: string) => {
        updatedIds.push(id);
        return { id: "plan_updated" };
      },
      create: async () => {
        throw new Error("should not create");
      },
      publish: async () => ({ id: "plan_published" }),
    },
  } as unknown as OpenMeter;

  const ref = await forceSyncOwnerAllowancePlanWithClient(client, {
    planKey: "pymthouse_owner_paid",
    planName: "Owner Paid",
    planKind: "owner_paid",
    featureId: "feat_1",
    includedUsdMicros: "10000000",
    warnLabel: "owner paid",
  });
  assert.deepEqual(updatedIds, ["plan_old"]);
  assert.equal(ref.key, "pymthouse_owner_paid");
  assert.equal(ref.openmeterPlanId, "plan_published");
  assert.equal(ref.includedUsdMicros, "10000000");
});

test("forceSyncOwnerAllowancePlanWithClient creates a new draft when update is immutable", async () => {
  const client = {
    plans: {
      list: async () => ({
        items: [{ id: "plan_live", key: "pymthouse_owner_paid", status: "active" }],
      }),
      get: async () => null,
      update: async () => {
        throw new Error("only Plans in [draft scheduled] can be updated");
      },
      create: async () => ({ id: "plan_draft" }),
      publish: async () => ({ id: "plan_new_pub" }),
    },
  } as unknown as OpenMeter;

  const ref = await forceSyncOwnerAllowancePlanWithClient(client, {
    planKey: "pymthouse_owner_paid",
    planName: "Owner Paid",
    planKind: "owner_paid",
    featureId: "feat_1",
    includedUsdMicros: "8000000",
    warnLabel: "owner paid",
  });
  assert.equal(ref.openmeterPlanId, "plan_new_pub");
  assert.equal(ref.includedUsdMicros, "8000000");
});

test("forceSyncOwnerAllowancePlanWithClient creates when plan is missing", async () => {
  const client = {
    plans: {
      list: async () => ({ items: [] }),
      get: async () => {
        throw new Error("not found");
      },
      update: async () => {
        throw new Error("should not update");
      },
      create: async () => ({ id: "plan_created" }),
      publish: async () => ({ id: "plan_created_pub" }),
    },
  } as unknown as OpenMeter;

  const ref = await forceSyncOwnerAllowancePlanWithClient(client, {
    planKey: "pymthouse_owner_starter",
    planName: "Owner Starter",
    planKind: "owner_starter",
    featureId: "feat_1",
    includedUsdMicros: "5000000",
    warnLabel: "owner starter",
  });
  assert.equal(ref.openmeterPlanId, "plan_created_pub");
  assert.equal(ref.key, "pymthouse_owner_starter");
});

test("forceSyncOwnerAllowancePlanWithClient rethrows non-immutable update errors", async () => {
  const client = {
    plans: {
      list: async () => ({
        items: [{ id: "plan_x", key: "pymthouse_owner_paid" }],
      }),
      get: async () => null,
      update: async () => {
        throw new Error("boom: permission denied");
      },
      create: async () => ({ id: "unused" }),
      publish: async () => ({ id: "unused" }),
    },
  } as unknown as OpenMeter;

  await assert.rejects(
    () =>
      forceSyncOwnerAllowancePlanWithClient(client, {
        planKey: "pymthouse_owner_paid",
        planName: "Owner Paid",
        planKind: "owner_paid",
        featureId: "feat_1",
        includedUsdMicros: "5000000",
        warnLabel: "owner paid",
      }),
    /permission denied/,
  );
});
