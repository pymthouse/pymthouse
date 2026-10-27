import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCreateDiscoveryProfileInput,
  parseUpdateDiscoveryProfileInput,
} from "./discovery-profile-input";

test("parseCreateDiscoveryProfileInput validates duplicate capabilities", () => {
  const parsed = parseCreateDiscoveryProfileInput({
    name: "Profile A",
    capabilities: [
      { pipeline: "llm", modelId: "*", discoveryPolicy: { topN: 2 } },
      { pipeline: "llm", modelId: "*", discoveryPolicy: { topN: 3 } },
    ],
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /duplicate capability/);
});

test("parseCreateDiscoveryProfileInput validates nested discovery policy", () => {
  const parsed = parseCreateDiscoveryProfileInput({
    name: "Profile A",
    capabilities: [{ pipeline: "llm", modelId: "*", discoveryPolicy: { sortBy: "nope" } }],
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /sortBy/);
});

test("parseCreateDiscoveryProfileInput parses valid payload", () => {
  const parsed = parseCreateDiscoveryProfileInput({
    name: "Profile A",
    policy: { topN: 8, sortBy: "price" },
    capabilities: [{ pipeline: "vid", modelId: "*", discoveryPolicy: { topN: 2 } }],
  });
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.name, "Profile A");
  assert.equal(parsed.value.policy?.topN, 8);
  assert.equal(parsed.value.capabilities[0]?.pipeline, "vid");
});

test("parseUpdateDiscoveryProfileInput preserves existing name when omitted", () => {
  const parsed = parseUpdateDiscoveryProfileInput(
    { policy: { topN: 4 } },
    { name: "Existing", policy: null },
  );
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.name, "Existing");
  assert.equal(parsed.value.policy?.topN, 4);
});
