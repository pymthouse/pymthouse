import test from "node:test";
import assert from "node:assert/strict";

import { estimateEndUserBillableMicros, loadActiveRetailRatesForApp } from "./retail-usage";

test("retail estimate uses capability rate for pipeline (unit math)", async () => {
  const lookup = {
    defaultRateUsd: "0.000001",
    byPipeline: new Map([["live-video-to-video", "0.000011"]]),
    byPipelineModel: new Map([["live-video-to-video|*", "0.000011"]]),
  };
  const network = 100_000n;
  const retail = estimateEndUserBillableMicros({
    networkFeeUsdMicros: network,
    lookup,
    pipeline: "live-video-to-video",
    modelId: "*",
  });
  assert.equal(retail, "1100000");
});

test("loadActiveRetailRatesForApp returns defaults without DB when unset", async (t) => {
  if (process.env.PYMTHOUSE_TEST_DATABASE_URL_UNSET === "1") {
    t.skip("database not configured");
  }
  const lookup = await loadActiveRetailRatesForApp("nonexistent-app-id-for-test");
  assert.ok(lookup.defaultRateUsd);
});
