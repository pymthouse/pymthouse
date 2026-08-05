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

test("buildDiscoverOrchestratorsUrl preserves path and strips query/fragment", () => {
  assert.equal(
    buildDiscoverOrchestratorsUrl("https://signer.example/api?tenant=a#frag"),
    "https://signer.example/api/discover-orchestrators",
  );
  assert.equal(
    buildDiscoverOrchestratorsUrl("https://signer.example/v1/"),
    "https://signer.example/v1/discover-orchestrators",
  );
});

test("buildDiscoverOrchestratorsUrl rejects empty or non-http URLs", () => {
  assert.throws(() => buildDiscoverOrchestratorsUrl("  "), /signer URL is required/);
  assert.throws(() => buildDiscoverOrchestratorsUrl("not-a-url"), /absolute http/);
  assert.throws(
    () => buildDiscoverOrchestratorsUrl("ftp://signer.example"),
    /http\(s\) URL/,
  );
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
