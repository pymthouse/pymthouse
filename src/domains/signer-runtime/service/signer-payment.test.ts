import assert from "node:assert/strict";
import test from "node:test";
import { parseSignerPaymentRequest } from "./signer-payment";

test("parseSignerPaymentRequest rejects conflicting aliases", () => {
  const parsed = parseSignerPaymentRequest({
    ManifestID: "a",
    manifestId: "b",
  });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.match(parsed.message, /Conflicting manifestId\/ManifestID\/manifestID/);
  }
});

test("parseSignerPaymentRequest normalizes alias fields", () => {
  const parsed = parseSignerPaymentRequest({
    ManifestID: "manifest-1",
    InPixels: "42",
    PreloadSeconds: 5,
    Type: "lv2v",
    Orchestrator: "orch-payload",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value, {
      manifestId: "manifest-1",
      inPixels: 42,
      preloadSeconds: 5,
      jobType: "lv2v",
      orchestratorData: "orch-payload",
    });
  }
});
