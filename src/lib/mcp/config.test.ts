import assert from "node:assert/strict";
import test from "node:test";

import { extractBearerToken, readDiscoveryServiceUrl } from "@/lib/mcp/config";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
) {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    prior[key] = process.env[key];
    const next = overrides[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("extractBearerToken accepts Bearer and raw tokens", () => {
  assert.equal(extractBearerToken("Bearer abc"), "abc");
  assert.equal(extractBearerToken("raw-key"), "raw-key");
});

test("extractBearerToken rejects empty", () => {
  assert.throws(() => extractBearerToken(null), /required/);
  assert.throws(() => extractBearerToken("   "), /required/);
});

test("readDiscoveryServiceUrl prefers DISCOVERY_SERVICE_URL and strips slash", () => {
  withEnv(
    {
      DISCOVERY_SERVICE_URL: "https://discovery.example/",
      DISCOVERY_URL: "https://ignored.example",
    },
    () => {
      assert.equal(readDiscoveryServiceUrl(), "https://discovery.example");
    },
  );
});

test("readDiscoveryServiceUrl falls back to DISCOVERY_URL then default", () => {
  withEnv(
    {
      DISCOVERY_SERVICE_URL: undefined,
      DISCOVERY_URL: "https://alt.example/",
    },
    () => {
      assert.equal(readDiscoveryServiceUrl(), "https://alt.example");
    },
  );
  withEnv(
    {
      DISCOVERY_SERVICE_URL: undefined,
      DISCOVERY_URL: undefined,
    },
    () => {
      assert.match(readDiscoveryServiceUrl(), /^https:\/\//);
    },
  );
});
