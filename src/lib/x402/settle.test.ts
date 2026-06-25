import test from "node:test";
import assert from "node:assert/strict";
import { usdcRawToUsdMicros } from "@/lib/x402/settle";

test("usdcRawToUsdMicros is 1:1 with USD micros", () => {
  assert.equal(usdcRawToUsdMicros(1_500_000n), 1_500_000n);
});
