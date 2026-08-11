import assert from "node:assert/strict";
import test from "node:test";

import {
  sortSubscriptionHistoryItems,
  type AppUserSubscriptionHistoryItem,
} from "@/lib/openmeter/app-user-subscription-history";

function item(
  partial: Partial<AppUserSubscriptionHistoryItem> & { id: string },
): AppUserSubscriptionHistoryItem {
  return {
    status: "inactive",
    current: false,
    planId: null,
    planName: null,
    planKey: null,
    openmeterPlanId: null,
    activeFrom: null,
    activeTo: null,
    ...partial,
  };
}

test("sortSubscriptionHistoryItems orders by activeFrom descending", () => {
  const sorted = sortSubscriptionHistoryItems([
    item({ id: "a", activeFrom: "2026-08-11T01:00:00.000Z" }),
    item({ id: "b", activeFrom: "2026-08-11T02:00:00.000Z" }),
    item({ id: "c", activeFrom: null }),
    item({ id: "d", activeFrom: "2026-08-11T01:30:00.000Z" }),
  ]);
  assert.deepEqual(
    sorted.map((row) => row.id),
    ["b", "d", "a", "c"],
  );
});
