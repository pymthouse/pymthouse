import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultRetailRateUsd,
  markupPercentToRetailRateUsd,
  retailRateUsdToMarkupPercent,
  NETWORK_USD_PER_MICRO,
} from "@pymthouse/builder-sdk";

test("markupPercentToRetailRateUsd converts markup to retail $/micro", () => {
  assert.equal(markupPercentToRetailRateUsd(0), defaultRetailRateUsd());
  assert.equal(markupPercentToRetailRateUsd(50), "0.0000015");
  assert.equal(markupPercentToRetailRateUsd(100), "0.000002");
});

test("retailRateUsdToMarkupPercent inverts markup for UI", () => {
  assert.equal(retailRateUsdToMarkupPercent(defaultRetailRateUsd()), "0");
  assert.equal(retailRateUsdToMarkupPercent("0.0000015"), "50");
});

test("defaultRetailRateUsd matches network pass-through", () => {
  assert.equal(defaultRetailRateUsd(), String(NETWORK_USD_PER_MICRO));
});
