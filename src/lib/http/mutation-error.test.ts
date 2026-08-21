import assert from "node:assert/strict";
import test from "node:test";

import { readMutationError } from "@/lib/http/mutation-error";

test("readMutationError prefers error, then detail, then title", () => {
  assert.equal(
    readMutationError({ error: "boom", detail: "d", title: "t" }, "fb"),
    "boom",
  );
  assert.equal(
    readMutationError({ detail: "Stripe Connect required", title: "t" }, "fb"),
    "Stripe Connect required",
  );
  assert.equal(
    readMutationError({ title: "Payment method required" }, "fb"),
    "Payment method required",
  );
  assert.equal(readMutationError({ error: "  " }, "fb"), "fb");
  assert.equal(readMutationError({}, "Failed to create (403)"), "Failed to create (403)");
});
