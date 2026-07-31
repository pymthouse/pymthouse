import assert from "node:assert/strict";
import test from "node:test";

import {
  bucketPoints,
  buildNiceTicks,
  buildSeriesColorMap,
  niceStep,
  pointMagnitude,
} from "@/lib/usage/chart-scale";

test("buildNiceTicks produces round axis values, not 29/58/87/116", () => {
  // The reported axis: a peak of 96 previously yielded 0/29/58/87/116.
  const ticks = buildNiceTicks(96, { integerOnly: true });
  assert.deepEqual(ticks, [0, 25, 50, 75, 100]);
});

test("buildNiceTicks snaps to 1/2/2.5/5/10 magnitudes", () => {
  assert.deepEqual(buildNiceTicks(4, { integerOnly: true }), [0, 1, 2, 3, 4]);
  assert.deepEqual(buildNiceTicks(40, { integerOnly: true }), [0, 10, 20, 30, 40]);
  assert.deepEqual(buildNiceTicks(900, { integerOnly: true }), [0, 250, 500, 750, 1000]);
});

test("buildNiceTicks always spans the peak", () => {
  for (const peak of [1, 7, 13, 96, 137, 1001, 45678]) {
    const ticks = buildNiceTicks(peak, { integerOnly: true });
    assert.ok(
      (ticks.at(-1) ?? 0) >= peak,
      `top tick ${ticks.at(-1)} must cover peak ${peak}`,
    );
    assert.equal(ticks[0], 0, "axis starts at zero");
  }
});

test("buildNiceTicks keeps request axes on whole numbers", () => {
  const ticks = buildNiceTicks(3, { integerOnly: true });
  assert.ok(
    ticks.every((tick) => Number.isInteger(tick)),
    `expected integer ticks, got ${ticks.join(",")}`,
  );
});

test("buildNiceTicks allows fractional steps for money axes", () => {
  const ticks = buildNiceTicks(0.8);
  assert.ok((ticks.at(-1) ?? 0) >= 0.8);
  assert.ok(ticks.length > 1);
});

test("buildNiceTicks degrades gracefully for empty or invalid peaks", () => {
  assert.deepEqual(buildNiceTicks(0), [0, 1, 2, 3, 4]);
  assert.deepEqual(buildNiceTicks(Number.NaN), [0, 1, 2, 3, 4]);
  assert.deepEqual(buildNiceTicks(-5), [0, 1, 2, 3, 4]);
});

test("niceStep rounds up to a readable magnitude", () => {
  assert.equal(niceStep(24), 25);
  assert.equal(niceStep(0.4), 0.5);
  assert.equal(niceStep(6), 10);
  assert.equal(niceStep(0), 1);
});

test("bucketPoints in day mode passes points through in date order", () => {
  const out = bucketPoints(
    [
      { date: "2026-07-02", value: 2, feeUsdMicros: "200" },
      { date: "2026-07-01", value: 1, feeUsdMicros: "100" },
    ],
    "day",
  );
  assert.deepEqual(
    out.map((p) => p.date),
    ["2026-07-01", "2026-07-02"],
  );
  assert.equal(out[0].feeUsdMicros, "100");
});

test("bucketPoints groups weeks into 7-day buckets and sums both measures", () => {
  const points = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    value: 1,
    feeUsdMicros: "1000",
  }));
  const out = bucketPoints(points, "week");

  assert.equal(out.length, 2);
  assert.equal(out[0].date, "2026-07-01");
  assert.equal(out[0].endDate, "2026-07-07");
  assert.equal(out[0].value, 7);
  assert.equal(out[0].feeUsdMicros, "7000");
  assert.equal(out[1].date, "2026-07-08");
  assert.equal(out[1].endDate, "2026-07-14");
});

test("bucketPoints keeps a short trailing week as its own bucket", () => {
  const points = Array.from({ length: 9 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    value: 2,
  }));
  const out = bucketPoints(points, "week");

  assert.equal(out.length, 2);
  assert.equal(out[1].value, 4, "trailing partial week keeps its own total");
  assert.equal(out[1].endDate, "2026-07-09");
});

test("bucketPoints sums fees beyond Number precision", () => {
  const out = bucketPoints(
    [
      { date: "2026-07-01", value: 1, feeUsdMicros: "9007199254740991" },
      { date: "2026-07-02", value: 1, feeUsdMicros: "9007199254740991" },
    ],
    "week",
  );
  assert.equal(out[0].feeUsdMicros, "18014398509481982");
});

test("pointMagnitude switches measure without a second axis", () => {
  const point = {
    date: "2026-07-01",
    endDate: "2026-07-01",
    value: 42,
    feeUsdMicros: "2500000",
  };
  assert.equal(pointMagnitude(point, "requests"), 42);
  assert.equal(pointMagnitude(point, "cost"), 2.5);
});

test("buildSeriesColorMap keeps colours stable when series are filtered out", () => {
  const all = ["app1|a", "app1|b", "app2|c"];
  const map = buildSeriesColorMap(all, 8);

  // Filtering the chart must look up the same slots, not reassign by position.
  assert.equal(map.get("app2|c"), 2);
  assert.equal(map.get("app1|b"), 1);
});

test("buildSeriesColorMap assigns distinct slots within the palette size", () => {
  const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
  const map = buildSeriesColorMap(keys, 8);
  assert.equal(new Set(map.values()).size, 8, "no two series share a slot");
});

test("buildSeriesColorMap dedupes repeated keys", () => {
  const map = buildSeriesColorMap(["a", "a", "b"], 8);
  assert.equal(map.size, 2);
  assert.equal(map.get("b"), 1);
});
