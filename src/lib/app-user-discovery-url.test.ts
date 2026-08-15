import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDiscoveryUrlPreference,
  resolveSignerSessionDiscoveryUrl,
} from "@/lib/app-user-discovery-url";

test("parseDiscoveryUrlPreference omits when undefined", () => {
  assert.deepEqual(parseDiscoveryUrlPreference(undefined), {
    ok: true,
    present: false,
  });
});

test("parseDiscoveryUrlPreference clears on null or blank", () => {
  assert.deepEqual(parseDiscoveryUrlPreference(null), {
    ok: true,
    present: true,
    discoveryUrl: null,
  });
  assert.deepEqual(parseDiscoveryUrlPreference("  "), {
    ok: true,
    present: true,
    discoveryUrl: null,
  });
});

test("parseDiscoveryUrlPreference accepts http(s) URLs", () => {
  assert.deepEqual(
    parseDiscoveryUrlPreference("https://disc.example/discover-orchestrators"),
    {
      ok: true,
      present: true,
      discoveryUrl: "https://disc.example/discover-orchestrators",
    },
  );
});

test("parseDiscoveryUrlPreference rejects non-URLs", () => {
  const bad = parseDiscoveryUrlPreference("not-a-url");
  assert.equal(bad.ok, false);
  const wrongType = parseDiscoveryUrlPreference(1);
  assert.equal(wrongType.ok, false);
});

test("resolveSignerSessionDiscoveryUrl prefers request then user preference", () => {
  assert.equal(
    resolveSignerSessionDiscoveryUrl({
      requestOverride: "https://req.example/discover-orchestrators",
      userPreference: "https://pref.example/discover-orchestrators",
      signerUrl: "https://signer.example",
    }),
    "https://req.example/discover-orchestrators",
  );
  assert.equal(
    resolveSignerSessionDiscoveryUrl({
      userPreference: "https://pref.example/discover-orchestrators",
      signerUrl: "https://signer.example",
    }),
    "https://pref.example/discover-orchestrators",
  );
  assert.equal(
    resolveSignerSessionDiscoveryUrl({
      signerUrl: "https://signer.example",
    }),
    "https://signer.example/discover-orchestrators",
  );
});
