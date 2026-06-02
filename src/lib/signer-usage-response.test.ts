import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSignerUsageSnapshot,
  stripSignerUsageFromResponse,
} from "./signer-usage-response";

test("parseSignerUsageSnapshot reads authoritative billing fields", () => {
  const snapshot = parseSignerUsageSnapshot({
    payment: "signed",
    usage: {
      request_id: "req-1",
      computed_fee_wei: "1000000000000000000",
      computed_fee_usd_micros: "3000000000",
      eth_usd_price: "3000",
      eth_usd_round_id: "42",
      eth_usd_updated_at: "2026-05-30T00:00:00.000Z",
      pipeline: "text-to-image",
      model_id: "stabilityai/sdxl",
      pixels: "1000000",
    },
  });

  assert.ok(snapshot);
  assert.equal(snapshot!.requestId, "req-1");
  assert.equal(snapshot!.computedFeeWei, "1000000000000000000");
  assert.equal(snapshot!.computedFeeUsdMicros, 3000000000n);
  assert.equal(snapshot!.ethUsdPrice, "3000");
  assert.equal(snapshot!.ethUsdRoundId, "42");
  assert.equal(snapshot!.pipeline, "text-to-image");
  assert.equal(snapshot!.modelId, "stabilityai/sdxl");
  assert.equal(snapshot!.pixels, "1000000");
});

test("parseSignerUsageSnapshot returns null when usage block is incomplete", () => {
  assert.equal(parseSignerUsageSnapshot({ usage: { request_id: "x" } }), null);
  assert.equal(parseSignerUsageSnapshot({ payment: "only" }), null);
});

test("stripSignerUsageFromResponse removes usage from downstream payload", () => {
  const body = {
    payment: "signed",
    usage: { request_id: "req-1", computed_fee_wei: "1", computed_fee_usd_micros: "1" },
  };
  stripSignerUsageFromResponse(body);
  assert.equal("usage" in body, false);
  assert.equal(body.payment, "signed");
});
