import assert from "node:assert/strict";
import test from "node:test";

import { earliestUsageCycleKeyFromRows } from "@/lib/usage/usage-cycle-keys";

test("earliestUsageCycleKeyFromRows ignores empty months", () => {
  assert.equal(
    earliestUsageCycleKeyFromRows([
      { windowStart: "2026-07-01T00:00:00.000Z", value: 0 },
      { windowStart: "2026-08-01T00:00:00.000Z", value: 4 },
      { windowStart: "2026-09-01T00:00:00.000Z", value: 1 },
    ]),
    "2026-08",
  );
});

test("earliestUsageCycleKeyFromRows returns null when nothing was metered", () => {
  assert.equal(
    earliestUsageCycleKeyFromRows([
      { windowStart: "2026-09-01T00:00:00.000Z", value: 0 },
    ]),
    null,
  );
});
