import test from "node:test";
import assert from "node:assert/strict";
import type { OpenMeter } from "@openmeter/sdk";
import {
  ensureOpenMeterCustomer,
  resetEnsuredCustomerCacheForTests,
} from "@/lib/openmeter/customers";

function fakeClient(counters: { gets: number }): OpenMeter {
  return {
    customers: {
      get: async (key: string) => {
        counters.gets += 1;
        return {
          id: `id-${key}`,
          key,
          usageAttribution: { subjectKeys: [key] },
        };
      },
    },
  } as unknown as OpenMeter;
}

test("ensureOpenMeterCustomer caches ensures per customer key", async (t) => {
  process.env.OPENMETER_CUSTOMER_ENSURE_CACHE_TTL_SECONDS = "60";
  resetEnsuredCustomerCacheForTests();
  t.after(() => {
    delete process.env.OPENMETER_CUSTOMER_ENSURE_CACHE_TTL_SECONDS;
    resetEnsuredCustomerCacheForTests();
  });

  const counters = { gets: 0 };
  const client = fakeClient(counters);

  assert.deepEqual(await ensureOpenMeterCustomer(client, "app_x:user-1"), {
    id: "id-app_x:user-1",
    key: "app_x:user-1",
  });
  assert.deepEqual(await ensureOpenMeterCustomer(client, "app_x:user-1"), {
    id: "id-app_x:user-1",
    key: "app_x:user-1",
  });
  assert.equal(counters.gets, 1);

  await ensureOpenMeterCustomer(client, "app_x:user-2");
  assert.equal(counters.gets, 2);
});

test("ensureOpenMeterCustomer cache is disabled by default in tests", async (t) => {
  resetEnsuredCustomerCacheForTests();
  t.after(() => resetEnsuredCustomerCacheForTests());

  const counters = { gets: 0 };
  const client = fakeClient(counters);

  await ensureOpenMeterCustomer(client, "app_x:user-1");
  await ensureOpenMeterCustomer(client, "app_x:user-1");
  assert.equal(counters.gets, 2);
});
