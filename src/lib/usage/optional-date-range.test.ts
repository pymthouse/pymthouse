import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DATE_RANGE_DAYS } from "@/lib/billing-utils";
import { parseOptionalDateRange } from "@/lib/usage/optional-date-range";

test("parseOptionalDateRange allows omitting both bounds", () => {
  assert.deepEqual(parseOptionalDateRange(new URLSearchParams()), {
    from: undefined,
    to: undefined,
  });
});

test("parseOptionalDateRange rejects a lone from or to", () => {
  assert.deepEqual(
    parseOptionalDateRange(new URLSearchParams({ from: "2026-09-01T00:00:00.000Z" })),
    { error: "from and to must be supplied together" },
  );
  assert.deepEqual(
    parseOptionalDateRange(new URLSearchParams({ to: "2026-09-05T00:00:00.000Z" })),
    { error: "from and to must be supplied together" },
  );
});

test("parseOptionalDateRange accepts a paired bounded range", () => {
  const from = "2026-09-01T00:00:00.000Z";
  const to = "2026-09-05T23:59:59.999Z";
  assert.deepEqual(parseOptionalDateRange(new URLSearchParams({ from, to })), {
    from,
    to,
  });
});

test("parseOptionalDateRange trims whitespace around bounds", () => {
  const from = "2026-09-01T00:00:00.000Z";
  const to = "2026-09-05T23:59:59.999Z";
  assert.deepEqual(
    parseOptionalDateRange(new URLSearchParams({ from: `  ${from}  `, to: ` ${to}` })),
    { from, to },
  );
});

test("parseOptionalDateRange treats blank bounds as omitted", () => {
  assert.deepEqual(
    parseOptionalDateRange(new URLSearchParams({ from: "  ", to: "\t" })),
    { from: undefined, to: undefined },
  );
});

test("parseOptionalDateRange rejects inverted or overlong ranges", () => {
  const error = {
    error: `Invalid range; supply from <= to within ${MAX_DATE_RANGE_DAYS} days`,
  };
  assert.deepEqual(
    parseOptionalDateRange(
      new URLSearchParams({
        from: "2026-09-05T00:00:00.000Z",
        to: "2026-09-01T00:00:00.000Z",
      }),
    ),
    error,
  );
  assert.deepEqual(
    parseOptionalDateRange(
      new URLSearchParams({
        from: "2025-01-01T00:00:00.000Z",
        to: "2026-09-01T00:00:00.000Z",
      }),
    ),
    error,
  );
  assert.deepEqual(
    parseOptionalDateRange(
      new URLSearchParams({
        from: "not-a-date",
        to: "2026-09-01T00:00:00.000Z",
      }),
    ),
    error,
  );
});
