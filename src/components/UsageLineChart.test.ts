import assert from "node:assert/strict";
import test from "node:test";
import { buildYTicks, chartYScaleMax } from "./UsageLineChart";

test("buildYTicks returns identity ticks when max is zero or invalid", () => {
  assert.deepEqual(buildYTicks(0), [0, 1, 2, 3, 4]);
  assert.deepEqual(buildYTicks(-1), [0, 1, 2, 3, 4]);
  assert.deepEqual(buildYTicks(Number.NaN), [0, 1, 2, 3, 4]);
});

test("chartYScaleMax is at least 1 when ticks are all zero", () => {
  assert.equal(chartYScaleMax([0]), 1);
});

test("chartYScaleMax uses top tick when positive", () => {
  assert.equal(chartYScaleMax([0, 25, 50]), 50);
});
