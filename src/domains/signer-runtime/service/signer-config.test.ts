import assert from "node:assert/strict";
import test from "node:test";

import { parseSignerConfigUpdate, parseTail } from "./signer-config";

test("parseTail clamps and defaults", () => {
  assert.equal(parseTail(null), 50);
  assert.equal(parseTail("5000"), 1000);
});

test("parseSignerConfigUpdate validates signerUrl", () => {
  const result = parseSignerConfigUpdate({
    body: { signerUrl: "nope" },
    current: undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.body.error, "signerUrl must be a valid http(s) URL or empty");
});

test("parseSignerConfigUpdate accepts remote discovery interval", () => {
  const result = parseSignerConfigUpdate({
    body: { remoteDiscovery: true, liveAICapReportInterval: "5m" },
    current: { remoteDiscovery: 0 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.updates.liveAICapReportInterval : "", "5m");
});
