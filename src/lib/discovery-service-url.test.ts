import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiscoverOrchestratorsUrl,
  normalizeDiscoveryCaps,
} from "@/lib/discovery-service-url";

test("buildDiscoverOrchestratorsUrl appends discover-orchestrators", () => {
  assert.equal(
    buildDiscoverOrchestratorsUrl("https://signer.pymthouse.com"),
    "https://signer.pymthouse.com/discover-orchestrators",
  );
  assert.equal(
    buildDiscoverOrchestratorsUrl("https://signer.example/"),
    "https://signer.example/discover-orchestrators",
  );
});

test("buildDiscoverOrchestratorsUrl rejects empty signer URL", () => {
  assert.throws(() => buildDiscoverOrchestratorsUrl("  "), /signer URL is required/);
});

test("normalizeDiscoveryCaps trims, drops empties, dedupes", () => {
  assert.equal(normalizeDiscoveryCaps(undefined), undefined);
  assert.equal(normalizeDiscoveryCaps([]), undefined);
  assert.deepEqual(
    normalizeDiscoveryCaps([
      " live-video-to-video/streamdiffusion ",
      "",
      "text-to-image/flux",
      "live-video-to-video/streamdiffusion",
    ]),
    [
      "live-video-to-video/streamdiffusion",
      "text-to-image/flux",
    ],
  );
});
