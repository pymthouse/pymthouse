import assert from "node:assert/strict";
import test from "node:test";

import { buildGrantIdempotencyKey } from "./admin-grant-idempotency";

test("admin grant idempotency key is stable within the same minute bucket", () => {
  const nowMs = 1_700_000_000_000;
  const a = buildGrantIdempotencyKey({
    adminId: "admin-1",
    ownerUserId: "owner-1",
    amountUsdMicros: "150000000",
    source: "manual",
    note: "CS-123 goodwill",
    nowMs,
  });
  const b = buildGrantIdempotencyKey({
    adminId: "admin-1",
    ownerUserId: "owner-1",
    amountUsdMicros: "150000000",
    source: "manual",
    note: "CS-123 goodwill",
    nowMs: nowMs + 30_000,
  });
  assert.equal(a, b);
  assert.match(a, /^admin-credit-grant:admin-1:owner-1:150000000:manual:/);
});

test("admin grant idempotency key changes when note changes", () => {
  const nowMs = 1_700_000_000_000;
  const a = buildGrantIdempotencyKey({
    adminId: "admin-1",
    ownerUserId: "owner-1",
    amountUsdMicros: "150000000",
    source: "manual",
    note: "note-a",
    nowMs,
  });
  const b = buildGrantIdempotencyKey({
    adminId: "admin-1",
    ownerUserId: "owner-1",
    amountUsdMicros: "150000000",
    source: "manual",
    note: "note-b",
    nowMs,
  });
  assert.notEqual(a, b);
});
