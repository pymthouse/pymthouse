import assert from "node:assert/strict";
import test from "node:test";

import { parseCreatePlanInput, parseUpdatePlanInput } from "./plan-input";

test("parseCreatePlanInput validates required subscription billing fields", () => {
  const parsed = parseCreatePlanInput({
    name: "Subscription",
    type: "subscription",
    priceAmount: "20",
  });
  assert.equal(parsed.ok, false);
  assert.equal(
    parsed.ok ? "" : parsed.error,
    "includedUnits and overageRateWei are required for subscription plans",
  );
});

test("parseCreatePlanInput parses capabilities and pricing fields", () => {
  const parsed = parseCreatePlanInput({
    name: "Usage plan",
    type: "usage",
    overageRateWei: "25",
    includedUnits: "100",
    includedUsdMicros: "20000000",
    generalUpchargePercentBps: 2000,
    capabilities: [{ pipeline: "llm", modelId: "*", upchargePercentBps: 500 }],
  });
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.name, "Usage plan");
  assert.equal(parsed.value.capabilities[0]?.pipeline, "llm");
  assert.equal(parsed.value.capabilities[0]?.upchargePercentBps, 500);
  assert.equal(parsed.value.includedUsdMicros, "20000000");
});

test("parseUpdatePlanInput preserves existing type semantics for partial updates", () => {
  const parsed = parseUpdatePlanInput(
    { id: "plan-1", priceAmount: "30" },
    { type: "subscription", includedUnits: "1000", overageRateWei: "25" },
  );
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.id, "plan-1");
  assert.equal(parsed.value.type, "subscription");
  assert.equal(parsed.value.includedUnits, "1000");
  assert.equal(parsed.value.overageRateWei, "25");
});

test("parseUpdatePlanInput rejects malformed capabilities", () => {
  const parsed = parseUpdatePlanInput(
    { id: "plan-1", capabilities: [{ modelId: "*" }] },
    { type: "free", includedUnits: null, overageRateWei: null },
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? "" : parsed.error, "capabilities[0].pipeline is required");
});
