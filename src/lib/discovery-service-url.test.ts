import test from "node:test";
import assert from "node:assert/strict";

import { getDiscoveryRawUrl } from "@/lib/discovery-service-url";

const RAW =
  "https://discovery-service-production-8955.up.railway.app/v1/discovery/raw";
const RAW_LEGACY = `${RAW}?serviceType=legacy`;

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

test("getDiscoveryRawUrl returns configured URL as-is", () => {
  withEnv(
    {
      DISCOVERY_URL: RAW_LEGACY,
      DISCOVERY_SERVICE_URL: "https://other.example/v1/discovery/raw",
      ORCH_WEBHOOK_URL: undefined,
    },
    () => {
      assert.equal(getDiscoveryRawUrl(), RAW_LEGACY);
    },
  );
});

test("getDiscoveryRawUrl prefers DISCOVERY_URL then aliases", () => {
  withEnv(
    {
      DISCOVERY_URL: undefined,
      DISCOVERY_SERVICE_URL: RAW,
      LIVEPEER_DISCOVERY_SERVICE_URL: undefined,
      ORCH_WEBHOOK_URL: RAW_LEGACY,
    },
    () => {
      assert.equal(getDiscoveryRawUrl(), RAW);
    },
  );
  withEnv(
    {
      DISCOVERY_URL: undefined,
      DISCOVERY_SERVICE_URL: undefined,
      LIVEPEER_DISCOVERY_SERVICE_URL: undefined,
      ORCH_WEBHOOK_URL: RAW_LEGACY,
    },
    () => {
      assert.equal(getDiscoveryRawUrl(), RAW_LEGACY);
    },
  );
});
