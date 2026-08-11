import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMeter } from "@openmeter/sdk";

import {
  __testAppUserSubscriptionHistory,
  indexLocalPlansFromRows,
  listAppUserSubscriptionHistory,
  matchLocalPlan,
  sortSubscriptionHistoryItems,
  toHistoryItem,
  type AppUserSubscriptionHistoryItem,
} from "@/lib/openmeter/app-user-subscription-history";
import type { OpenMeterSubscriptionView } from "@/lib/openmeter/subscription-read";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plan-naming";

function item(
  partial: Partial<AppUserSubscriptionHistoryItem> & { id: string },
): AppUserSubscriptionHistoryItem {
  return {
    status: "inactive",
    current: false,
    planId: null,
    planName: null,
    planKey: null,
    openmeterPlanId: null,
    activeFrom: null,
    activeTo: null,
    ...partial,
  };
}

function sub(
  partial: Partial<OpenMeterSubscriptionView> & { id: string },
): OpenMeterSubscriptionView {
  return {
    status: "inactive",
    customerId: "cust_1",
    planKey: null,
    planId: null,
    activeFrom: null,
    activeTo: null,
    ...partial,
  };
}

test("sortSubscriptionHistoryItems orders by activeFrom descending", () => {
  const sorted = sortSubscriptionHistoryItems([
    item({ id: "a", activeFrom: "2026-08-11T01:00:00.000Z" }),
    item({ id: "b", activeFrom: "2026-08-11T02:00:00.000Z" }),
    item({ id: "c", activeFrom: null }),
    item({ id: "d", activeFrom: "2026-08-11T01:30:00.000Z" }),
  ]);
  assert.deepEqual(
    sorted.map((row) => row.id),
    ["b", "d", "a", "c"],
  );
});

test("sortSubscriptionHistoryItems ties break on id and prefers dated rows", () => {
  const sameTs = sortSubscriptionHistoryItems([
    item({ id: "z", activeFrom: "2026-08-11T01:00:00.000Z" }),
    item({ id: "a", activeFrom: "2026-08-11T01:00:00.000Z" }),
  ]);
  assert.deepEqual(
    sameTs.map((row) => row.id),
    ["z", "a"],
  );

  const nullFirst = sortSubscriptionHistoryItems([
    item({ id: "null", activeFrom: null }),
    item({ id: "dated", activeFrom: "2026-08-11T01:00:00.000Z" }),
  ]);
  assert.deepEqual(
    nullFirst.map((row) => row.id),
    ["dated", "null"],
  );

  const invalid = sortSubscriptionHistoryItems([
    item({ id: "bad", activeFrom: "not-a-date" }),
    item({ id: "ok", activeFrom: "2026-08-11T01:00:00.000Z" }),
  ]);
  assert.equal(invalid[0]?.id, "ok");
});

test("matchLocalPlan prefers openmeter plan id then plan key", () => {
  const byId = new Map([
    [
      "om_paid",
      {
        id: "local_paid",
        name: "Paid",
        isStarterDefault: false,
        openmeterPlanId: "om_paid",
      },
    ],
  ]);
  const planKey = buildOpenMeterPlanKey("app_1", "local_starter");
  const byKey = new Map([
    [
      planKey,
      {
        id: "local_starter",
        name: "Starter",
        isStarterDefault: true,
        openmeterPlanId: "om_starter",
      },
    ],
  ]);

  assert.equal(
    matchLocalPlan(sub({ id: "s1", planId: "om_paid" }), byId, byKey)?.id,
    "local_paid",
  );
  assert.equal(
    matchLocalPlan(
      sub({ id: "s2", planId: "missing", planKey }),
      byId,
      byKey,
    )?.id,
    "local_starter",
  );
  assert.equal(
    matchLocalPlan(sub({ id: "s3", planKey: "unknown" }), byId, byKey),
    null,
  );
  assert.equal(matchLocalPlan(sub({ id: "s4" }), byId, byKey), null);
});

test("toHistoryItem maps live status and local plan display name", () => {
  const live = toHistoryItem(
    sub({
      id: "sub_live",
      status: "active",
      planId: "om_1",
      planKey: "key_1",
      activeFrom: "2026-08-11T00:00:00.000Z",
      activeTo: null,
    }),
    {
      id: "local_1",
      name: "m2m user plan",
      isStarterDefault: false,
      openmeterPlanId: "om_1",
    },
  );
  assert.equal(live.current, true);
  assert.equal(live.planId, "local_1");
  assert.equal(live.planName, "m2m user plan");
  assert.equal(live.openmeterPlanId, "om_1");

  const starter = toHistoryItem(
    sub({
      id: "sub_starter",
      status: "inactive",
      planKey: "a1_plan_x",
    }),
    {
      id: "local_starter",
      name: "__pymthouse_starter__",
      isStarterDefault: true,
      openmeterPlanId: "om_starter",
    },
  );
  assert.equal(starter.current, false);
  assert.equal(starter.planName, "Starter");

  const unmapped = toHistoryItem(
    sub({
      id: "sub_owner",
      status: "trialing",
      planKey: "pymthouse_owner_starter",
    }),
    null,
  );
  assert.equal(unmapped.current, true);
  assert.equal(unmapped.planId, null);
  assert.ok(unmapped.planName);
});

test("listAppUserSubscriptionHistory returns empty without ids or OpenMeter", async () => {
  assert.deepEqual(
    await listAppUserSubscriptionHistory({
      clientId: "  ",
      externalUserId: "eu_1",
      deps: { isAvailable: () => true },
    }),
    { items: [], externalUserId: "eu_1" },
  );
  assert.deepEqual(
    await listAppUserSubscriptionHistory({
      clientId: "app_1",
      externalUserId: "  ",
      deps: { isAvailable: () => true },
    }),
    { items: [], externalUserId: "" },
  );
  assert.deepEqual(
    await listAppUserSubscriptionHistory({
      clientId: "app_1",
      externalUserId: "eu_1",
      deps: { isAvailable: () => false },
    }),
    { items: [], externalUserId: "eu_1" },
  );
});

test("listAppUserSubscriptionHistory returns empty when customer is missing", async () => {
  const result = await listAppUserSubscriptionHistory({
    clientId: "app_1",
    externalUserId: "eu_missing",
    deps: {
      isAvailable: () => true,
      getClient: () => ({}) as OpenMeter,
      lookupCustomerId: async () => null,
    },
  });
  assert.deepEqual(result, { items: [], externalUserId: "eu_missing" });
});

test("listAppUserSubscriptionHistory maps enriched subscriptions newest first", async () => {
  const client = { tag: "om" } as unknown as OpenMeter;
  const result = await listAppUserSubscriptionHistory({
    clientId: "app_1",
    externalUserId: "eu_1",
    deps: {
      isAvailable: () => true,
      getClient: () => client,
      lookupCustomerId: async (c, clientId, externalUserId) => {
        assert.equal(c, client);
        assert.equal(clientId, "app_1");
        assert.equal(externalUserId, "eu_1");
        return "cust_1";
      },
      listSubscriptions: async (c, customerId) => {
        assert.equal(c, client);
        assert.equal(customerId, "cust_1");
        return [
          sub({
            id: "older",
            status: "inactive",
            planId: "om_paid",
            planKey: "paid_key",
            activeFrom: null,
            activeTo: null,
          }),
          sub({
            id: "newer",
            status: "active",
            planId: "om_starter",
            planKey: "starter_key",
            activeFrom: null,
            activeTo: null,
          }),
        ];
      },
      enrichWindow: async (row) => {
        if (row.id === "newer") {
          return {
            ...row,
            activeFrom: "2026-08-11T02:00:00.000Z",
            activeTo: null,
          };
        }
        return {
          ...row,
          activeFrom: "2026-08-11T01:00:00.000Z",
          activeTo: "2026-08-11T02:00:00.000Z",
        };
      },
      loadPlans: async (appId) => {
        assert.equal(appId, "app_1");
        return {
          byOpenMeterId: new Map([
            [
              "om_paid",
              {
                id: "plan_paid",
                name: "m2m user plan",
                isStarterDefault: false,
                openmeterPlanId: "om_paid",
              },
            ],
            [
              "om_starter",
              {
                id: "plan_starter",
                name: "__pymthouse_starter__",
                isStarterDefault: true,
                openmeterPlanId: "om_starter",
              },
            ],
          ]),
          byPlanKey: new Map(),
        };
      },
    },
  });

  assert.equal(result.externalUserId, "eu_1");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.id, "newer");
  assert.equal(result.items[0]?.current, true);
  assert.equal(result.items[0]?.planName, "Starter");
  assert.equal(result.items[0]?.activeFrom, "2026-08-11T02:00:00.000Z");
  assert.equal(result.items[1]?.id, "older");
  assert.equal(result.items[1]?.planName, "m2m user plan");
  assert.equal(result.items[1]?.activeTo, "2026-08-11T02:00:00.000Z");
});

test("indexLocalPlansFromRows indexes by openmeter id and plan key", () => {
  const indexed = indexLocalPlansFromRows("app_1", [
    {
      id: "plan_paid",
      name: "Paid",
      isStarterDefault: false,
      openmeterPlanId: " om_paid ",
    },
    {
      id: "plan_starter",
      name: "Starter",
      isStarterDefault: true,
      openmeterPlanId: null,
    },
    {
      id: "plan_blank_om",
      name: "Blank",
      isStarterDefault: false,
      openmeterPlanId: "   ",
    },
  ]);
  assert.equal(indexed.byOpenMeterId.get("om_paid")?.id, "plan_paid");
  assert.equal(indexed.byOpenMeterId.has("om_blank"), false);
  assert.equal(
    indexed.byPlanKey.get(buildOpenMeterPlanKey("app_1", "plan_starter"))
      ?.isStarterDefault,
    true,
  );
});

test("__testAppUserSubscriptionHistory exposes helpers", () => {
  assert.equal(
    __testAppUserSubscriptionHistory.matchLocalPlan,
    matchLocalPlan,
  );
  assert.equal(__testAppUserSubscriptionHistory.toHistoryItem, toHistoryItem);
  assert.equal(
    __testAppUserSubscriptionHistory.indexLocalPlansFromRows,
    indexLocalPlansFromRows,
  );
  assert.equal(typeof __testAppUserSubscriptionHistory.lookupCustomerId, "function");
  assert.equal(typeof __testAppUserSubscriptionHistory.loadLocalPlans, "function");
});
