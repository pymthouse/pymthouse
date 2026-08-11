import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LEGACY_AUTO_TOP_UP_METADATA_FLAG,
  isLegacyAutoTopUpPaymentIntentMetadata,
  legacyAutoTopUpGrantIdempotencyKey,
} from "@/lib/stripe/legacy-auto-topup";

test("legacyAutoTopUpGrantIdempotencyKey prefixes trimmed payment intent id", () => {
  assert.equal(
    legacyAutoTopUpGrantIdempotencyKey("  pi_abc  "),
    "autotopup:pi_abc",
  );
});

test("isLegacyAutoTopUpPaymentIntentMetadata requires flag=1", () => {
  assert.equal(isLegacyAutoTopUpPaymentIntentMetadata(null), false);
  assert.equal(isLegacyAutoTopUpPaymentIntentMetadata(undefined), false);
  assert.equal(isLegacyAutoTopUpPaymentIntentMetadata({}), false);
  assert.equal(
    isLegacyAutoTopUpPaymentIntentMetadata({
      [LEGACY_AUTO_TOP_UP_METADATA_FLAG]: "0",
    }),
    false,
  );
  assert.equal(
    isLegacyAutoTopUpPaymentIntentMetadata({
      [LEGACY_AUTO_TOP_UP_METADATA_FLAG]: "1",
    }),
    true,
  );
});
