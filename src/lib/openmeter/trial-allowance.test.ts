import assert from "node:assert/strict";
import test from "node:test";
import { starterGrantAmountUsdMicros } from "./trial-allowance";

test("starterGrantAmountUsdMicros parses plan includedUsdMicros", () => {
  assert.equal(starterGrantAmountUsdMicros("5000000"), 5_000_000n);
  assert.equal(starterGrantAmountUsdMicros("0"), 0n);
  assert.equal(starterGrantAmountUsdMicros(""), 0n);
  assert.equal(starterGrantAmountUsdMicros(null), 0n);
  assert.equal(starterGrantAmountUsdMicros(undefined), 0n);
  assert.equal(starterGrantAmountUsdMicros(" 1000 "), 1000n);
  assert.equal(starterGrantAmountUsdMicros("-1"), 0n);
  assert.equal(starterGrantAmountUsdMicros("1.5"), 0n);
  assert.equal(starterGrantAmountUsdMicros("abc"), 0n);
});
