import assert from "node:assert/strict";
import test from "node:test";

import { parseOptionalDateRange } from "@/lib/usage/parse-optional-date-range";

test("parseOptionalDateRange accepts a matching pair", async () => {
  const result = parseOptionalDateRange(
    new URLSearchParams({
      from: "2026-08-06T00:00:00.000Z",
      to: "2026-09-04T23:59:59.999Z",
    }),
  );
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.from, "2026-08-06T00:00:00.000Z");
  assert.equal(result.to, "2026-09-04T23:59:59.999Z");
});

test("parseOptionalDateRange rejects a lone bound", async () => {
  const result = parseOptionalDateRange(
    new URLSearchParams({ from: "2026-08-06T00:00:00.000Z" }),
  );
  assert.equal("error" in result, true);
  if (!("error" in result)) return;
  assert.equal(result.error.status, 400);
});

test("parseOptionalDateRange rejects a span over MAX_DATE_RANGE_DAYS", async () => {
  const result = parseOptionalDateRange(
    new URLSearchParams({
      from: "2025-01-01T00:00:00.000Z",
      to: "2026-09-04T23:59:59.999Z",
    }),
  );
  assert.equal("error" in result, true);
  if (!("error" in result)) return;
  assert.equal(result.error.status, 400);
});

test("parseOptionalDateRange allows omitted bounds", async () => {
  const result = parseOptionalDateRange(new URLSearchParams());
  assert.equal("error" in result, false);
  if ("error" in result) return;
  assert.equal(result.from, undefined);
  assert.equal(result.to, undefined);
});
