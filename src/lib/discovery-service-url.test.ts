import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCOVERY_RAW_PATH,
  getDiscoveryRawUrl,
  getDiscoveryServiceBaseUrl,
  normalizeDiscoveryServiceBaseUrl,
  readConfiguredDiscoveryUrl,
  resolveDiscoveryRawUrl,
} from "@/lib/discovery-service-url";

const ORIGIN = "https://discovery-service-production-8955.up.railway.app";
const RAW = `${ORIGIN}${DISCOVERY_RAW_PATH}`;
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

test("normalizeDiscoveryServiceBaseUrl strips raw path and query", () => {
  assert.equal(normalizeDiscoveryServiceBaseUrl(ORIGIN), ORIGIN);
  assert.equal(normalizeDiscoveryServiceBaseUrl(`${ORIGIN}/`), ORIGIN);
  assert.equal(normalizeDiscoveryServiceBaseUrl(RAW), ORIGIN);
  assert.equal(normalizeDiscoveryServiceBaseUrl(RAW_LEGACY), ORIGIN);
  assert.equal(
    normalizeDiscoveryServiceBaseUrl(`${ORIGIN}/v1/discovery/capabilities`),
    ORIGIN,
  );
});

test("resolveDiscoveryRawUrl builds raw from origin or preserves raw query", () => {
  assert.equal(resolveDiscoveryRawUrl(ORIGIN), RAW);
  assert.equal(resolveDiscoveryRawUrl(`${ORIGIN}/`), RAW);
  assert.equal(resolveDiscoveryRawUrl(RAW), RAW);
  assert.equal(resolveDiscoveryRawUrl(RAW_LEGACY), RAW_LEGACY);
});

test("readConfiguredDiscoveryUrl prefers DISCOVERY_URL then aliases", () => {
  withEnv(
    {
      DISCOVERY_URL: "https://a.example",
      DISCOVERY_SERVICE_URL: "https://b.example",
      LIVEPEER_DISCOVERY_SERVICE_URL: "https://c.example",
      ORCH_WEBHOOK_URL: "https://d.example/v1/discovery/raw",
    },
    () => {
      assert.equal(readConfiguredDiscoveryUrl(), "https://a.example");
    },
  );
  withEnv(
    {
      DISCOVERY_URL: undefined,
      DISCOVERY_SERVICE_URL: "https://b.example",
      LIVEPEER_DISCOVERY_SERVICE_URL: "https://c.example",
      ORCH_WEBHOOK_URL: "https://d.example/v1/discovery/raw",
    },
    () => {
      assert.equal(readConfiguredDiscoveryUrl(), "https://b.example");
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
      assert.equal(readConfiguredDiscoveryUrl(), RAW_LEGACY);
      assert.equal(getDiscoveryServiceBaseUrl(), ORIGIN);
      assert.equal(getDiscoveryRawUrl(), RAW_LEGACY);
    },
  );
});

test("origin-only DISCOVERY_SERVICE_URL yields raw for tokens", () => {
  withEnv(
    {
      DISCOVERY_URL: undefined,
      DISCOVERY_SERVICE_URL: ORIGIN,
      LIVEPEER_DISCOVERY_SERVICE_URL: undefined,
      ORCH_WEBHOOK_URL: undefined,
    },
    () => {
      assert.equal(getDiscoveryServiceBaseUrl(), ORIGIN);
      assert.equal(getDiscoveryRawUrl(), RAW);
    },
  );
});
