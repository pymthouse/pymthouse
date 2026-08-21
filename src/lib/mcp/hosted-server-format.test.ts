import test from "node:test";
import assert from "node:assert/strict";

import { projectDiscoveryQueryResult } from "@/lib/mcp/hosted-server-format";

test("projectDiscoveryQueryResult keeps id/avail/price/capabilities and total_count", () => {
  const projected = projectDiscoveryQueryResult({
    total_count: 40,
    results: [
      {
        id: "orch-1",
        avail: 0.9,
        price: 12,
        capabilities: ["live-video-to-video/streamdiffusion-sdxl"],
        extra: "drop-me",
      },
    ],
  });
  assert.equal(projected.total_count, 40);
  assert.deepEqual(projected.orchestrators, [
    {
      id: "orch-1",
      avail: 0.9,
      price: 12,
      capabilities: ["live-video-to-video/streamdiffusion-sdxl"],
    },
  ]);
});

test("projectDiscoveryQueryResult falls back to array length", () => {
  const projected = projectDiscoveryQueryResult({
    orchestrators: [{ id: "a" }, { id: "b" }],
  });
  assert.equal(projected.total_count, 2);
  assert.deepEqual(projected.orchestrators, [{ id: "a" }, { id: "b" }]);
});
