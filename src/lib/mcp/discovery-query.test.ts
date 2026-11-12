import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityAllowKeys,
  discoveryFreshnessFromDocument,
  filterRunnersByCapabilities,
  flattenDiscoveryDocument,
  freshestObservedAt,
  queryNodeDiscovery,
  rankRunners,
  type DiscoveryRunner,
} from "@/lib/mcp/discovery-query";

  const T0 = "2026-11-10T17:31:43.797658115Z";
  const T1 = "2026-11-10T17:31:44.100000000Z";
  const T2 = "2026-11-10T17:31:44.500000000Z";

const doc = [
  {
    address: "https://ai1.example:8936",
    runners: [
      {
        url: "https://ai1.example:8936/apps/app-1/session",
        app: "live/video-to-video",
        mode: "persistent",
        capacity: 1,
        capacityAvailable: 1,
        observedAt: T0,
        priceInfo: { price: 137391, currency: "wei", unit: "seconds" },
      },
      {
        url: "https://ai1.example:8936/apps/app-2/app",
        app: "media/ffmpeg-live",
        mode: "persistent",
        capacity: 1,
        capacityAvailable: 3,
        observedAt: T0,
        priceInfo: { price: 137391, currency: "wei", unit: "seconds" },
      },
      {
        url: "https://ai1.example:8936/apps/app-3/app",
        app: "text-to-image",
        mode: "single-shot",
        capacity: 8,
        capacityAvailable: 8,
        observedAt: T1,
        priceInfo: { price: 494605544, currency: "wei", unit: "fixed" },
      },
    ],
  },
  {
    address: "https://ai2.example:8936",
    runners: [
      {
        url: "https://ai2.example:8936/apps/app-4/app",
        app: "text-to-image",
        mode: "single-shot",
        capacity: 4,
        capacityAvailable: 4,
        observedAt: T2,
        priceInfo: { price: 48086650021, currency: "wei", unit: "seconds" },
      },
      {
        url: "https://ai2.example:8936/apps/app-5/app",
        app: "chat",
        mode: "single-shot",
        capacity: 8,
        capacityAvailable: 8,
        observedAt: T0,
        priceInfo: { price: 9625355572, currency: "wei", unit: "seconds" },
      },
    ],
  },
  {
    nodes: [
      { url: "https://ai1.example:8936", queried_at: "2026-11-10T17:31:43.814512142Z" },
    ],
  },
];

const runnerList = (doc[0].runners ?? []) as DiscoveryRunner[];

test("flattenDiscoveryDocument flattens runners from every entry", () => {
  const all = flattenDiscoveryDocument(doc);
  assert.equal(all.length, 5);
  assert.throws(
    () => flattenDiscoveryDocument({ not: "an array" }),
    new TypeError("discovery document must be a JSON array"),
  );
});

test("filterRunnersByCapabilities matches runner.app against requested capabilities", () => {
  const { kept, filteredCapabilities, droppedCapabilities } = filterRunnersByCapabilities(
    runnerList,
    ["live/video-to-video", "media/ffmpeg-live", "chat"],
  );
  assert.deepEqual(
    kept.map((r) => r.app),
    ["live/video-to-video", "media/ffmpeg-live"],
  );
  assert.deepEqual(filteredCapabilities, [
    "live/video-to-video",
    "media/ffmpeg-live",
    "chat",
  ]);
  assert.deepEqual(droppedCapabilities, []);
});

test("filterRunnersByCapabilities applies the manifest allowlist", () => {
  const manifest = [
    { pipeline: "live", modelId: "video-to-video" },
    { pipeline: "media", modelId: "ffmpeg-live" },
  ];
  const { kept, filteredCapabilities, droppedCapabilities } = filterRunnersByCapabilities(
    runnerList,
    ["live/video-to-video", "media/ffmpeg-live", "chat"],
    manifest,
  );
  assert.deepEqual(
    kept.map((r) => r.app),
    ["live/video-to-video", "media/ffmpeg-live"],
  );
  assert.deepEqual(filteredCapabilities, ["live/video-to-video", "media/ffmpeg-live"]);
  assert.deepEqual(droppedCapabilities, ["chat"]);
});

test("rankRunners defaults to avail desc, then price asc, then url", () => {
  const all = flattenDiscoveryDocument(doc);
  const { results, truncated } = rankRunners(all, "avail", 2);
  // Avail descending: the two text-to-image runners (avail 8) and chat
  // (avail 8) tie on the primary key, so price ascending breaks the tie:
  // text-to-image (494605544) before chat (9625355572), then the second
  // text-to-image (48086650021). Truncated count is 3.
  assert.deepEqual(
    results.map((r) => r.app),
    ["text-to-image", "chat"],
  );
  assert.equal(truncated, 3);
});

test("rankRunners sorts by price asc, then avail desc, then url", () => {
  const all = flattenDiscoveryDocument(doc);
  const { results } = rankRunners(all, "price", 5);
  // Price ascending:
  //   137391: media/ffmpeg-live (avail 3) before live/video-to-video (avail 1)
  //   48086650021: text-to-image (ai2, avail 4)
  //   494605544: text-to-image (ai1, avail 8) before chat (avail 8) — tie on
  //   avail 8 breaks by price ascending (494605544 < 9625355572)
  assert.deepEqual(
    results.map((r) => r.app),
    ["media/ffmpeg-live", "live/video-to-video", "text-to-image", "chat", "text-to-image"],
  );
});

test("rankRunners degrades latency/swapRate to simpler orders", () => {
  const a: DiscoveryRunner = {
    url: "https://x/app",
    app: "a",
    capacityAvailable: 1,
    priceInfo: { price: 100 },
  };
  const b: DiscoveryRunner = {
    url: "https://y/app",
    app: "b",
    capacityAvailable: 5,
    priceInfo: { price: 50 },
  };
  assert.deepEqual(rankRunners([a, b], "latency").results.map((r) => r.app), ["b", "a"]);
  assert.deepEqual(rankRunners([a, b], "swapRate").results.map((r) => r.app), ["b", "a"]);
});

test("queryNodeDiscovery combines filter + rank + topN", () => {
  const result = queryNodeDiscovery(doc, {
    capabilities: ["live/video-to-video", "media/ffmpeg-live", "chat"],
    manifestCapabilities: [
      { pipeline: "live", modelId: "video-to-video" },
      { pipeline: "media", modelId: "ffmpeg-live" },
      { pipeline: "chat", modelId: "gpt-4o" },
    ],
    sortBy: "avail",
    topN: 1,
  });
  assert.deepEqual(result.results.map((r) => r.app), ["media/ffmpeg-live"]);
  assert.equal(result.truncated, 1);
  assert.deepEqual(result.droppedCapabilities, ["chat"]);
  // Kept runners: live/video-to-video (T0) + media/ffmpeg-live (T0).
  assert.equal(result.freshestObservedAt, "2026-11-10T17:31:43.797658115Z");
});

test("freshestObservedAt picks the max RFC 3339 stamp", () => {
  assert.equal(
    freshestObservedAt(flattenDiscoveryDocument(doc)),
    "2026-11-10T17:31:44.500000000Z",
  );
  assert.equal(freshestObservedAt([]), null);
});

test("discoveryFreshnessFromDocument derives legacy-compatible fields", () => {
  const nowMs = Date.parse("2026-11-10T17:31:55.000000000Z");
  const f = discoveryFreshnessFromDocument(doc, nowMs);
  assert.equal(f.freshestObservedAt, "2026-11-10T17:31:44.500000000Z");
  assert.ok(f.ageMs !== null && f.ageMs > 0);
  assert.equal(f.capabilityCount, 4); // live/video-to-video, media/ffmpeg-live, text-to-image, chat
  assert.equal(f.totalRunners, 5);
  assert.equal(f.orchestratorCount, 2);
  assert.equal(f.populated, true);

  const empty = discoveryFreshnessFromDocument([], nowMs);
  assert.equal(empty.populated, false);
  assert.equal(empty.totalRunners, 0);
});

test("capabilityAllowKeys emits all separator spellings", () => {
  const keys = capabilityAllowKeys([
    { pipeline: "live", modelId: "video-to-video" },
    { pipeline: "streamdiffusion-sdxl", modelId: "streamdiffusion-sdxl" },
  ]);
  assert.ok(keys.has("live/video-to-video"));
  assert.ok(keys.has("live|video-to-video"));
  assert.ok(keys.has("live:video-to-video"));
  // Bare token: pipeline === modelId round-trips to the original token.
  assert.ok(keys.has("streamdiffusion-sdxl"));
  // Entry 1: live/*, live|*, live:* (3 keys).
  // Entry 2: streamdiffusion-sdxl/{,|,:}streamdiffusion-sdxl + the bare
  // token itself (4 keys). Total 7.
  assert.equal(keys.size, 7);
});
