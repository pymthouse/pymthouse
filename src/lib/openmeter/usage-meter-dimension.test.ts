import assert from "node:assert/strict";
import test from "node:test";

import {
  __testClearMeterModelDimensionCache,
  resolveMeterModelDimension,
} from "./usage-read";

function meterClient(
  groupBy: Record<string, unknown> | null | undefined,
  opts?: { failOnce?: { calls: number } },
) {
  return {
    meters: {
      get: async () => {
        if (opts?.failOnce) {
          opts.failOnce.calls += 1;
          if (opts.failOnce.calls === 1) {
            throw new Error("meter lookup failed");
          }
        }
        return { groupBy };
      },
    },
  };
}

test("resolveMeterModelDimension prefers app when the meter exposes it", async () => {
  __testClearMeterModelDimensionCache();
  assert.equal(
    await resolveMeterModelDimension({
      client: meterClient({ pipeline: "$.pipeline", app: "$.app" }),
      meterSlug: "network_fee_usd_micros",
    }),
    "app",
  );
});

test("resolveMeterModelDimension uses model_id for legacy meters", async () => {
  __testClearMeterModelDimensionCache();
  assert.equal(
    await resolveMeterModelDimension({
      client: meterClient({ pipeline: "$.pipeline", model_id: "$.model_id" }),
      meterSlug: "signed_ticket_count",
    }),
    "model_id",
  );
});

test("resolveMeterModelDimension does not cache a failed lookup", async () => {
  __testClearMeterModelDimensionCache();
  const failOnce = { calls: 0 };
  const client = meterClient({ app: "$.app" }, { failOnce });
  assert.equal(
    await resolveMeterModelDimension({
      client,
      meterSlug: "network_fee_usd_micros_fail",
    }),
    "model_id",
  );
  assert.equal(
    await resolveMeterModelDimension({
      client,
      meterSlug: "network_fee_usd_micros_fail",
    }),
    "app",
  );
  assert.equal(failOnce.calls, 2);
});
