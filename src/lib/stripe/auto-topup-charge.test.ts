import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_TOP_UP_METADATA_FLAG,
  autoTopUpGrantIdempotencyKey,
  isAutoTopUpPaymentIntentMetadata,
} from "@/lib/stripe/auto-topup-charge";

test("autoTopUpGrantIdempotencyKey prefixes trimmed payment intent id", () => {
  assert.equal(
    autoTopUpGrantIdempotencyKey("  pi_abc  "),
    "autotopup:pi_abc",
  );
});

test("isAutoTopUpPaymentIntentMetadata requires flag=1", () => {
  assert.equal(isAutoTopUpPaymentIntentMetadata(null), false);
  assert.equal(isAutoTopUpPaymentIntentMetadata(undefined), false);
  assert.equal(isAutoTopUpPaymentIntentMetadata({}), false);
  assert.equal(
    isAutoTopUpPaymentIntentMetadata({ [AUTO_TOP_UP_METADATA_FLAG]: "0" }),
    false,
  );
  assert.equal(
    isAutoTopUpPaymentIntentMetadata({ [AUTO_TOP_UP_METADATA_FLAG]: "1" }),
    true,
  );
});
