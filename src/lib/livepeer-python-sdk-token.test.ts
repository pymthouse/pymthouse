import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLivepeerPythonSdkTokenPayload,
  createLivepeerPythonSdkToken,
  encodeLivepeerPythonSdkToken,
  getLivepeerPythonSdkDiscoveryUrl,
} from "@/lib/livepeer-python-sdk-token";

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

test("buildLivepeerPythonSdkTokenPayload uses composite key in Bearer header", () => {
  const payload = buildLivepeerPythonSdkTokenPayload({
    apiKey: "app_abcdef0123456789abcdef01_pmth_deadbeef",
    signer: "https://pymthouse-production.up.railway.app/",
    discovery:
      "https://discovery-service-production-8955.up.railway.app/v1/discovery/raw?serviceType=legacy",
  });

  assert.deepEqual(payload, {
    signer: "https://pymthouse-production.up.railway.app/",
    discovery:
      "https://discovery-service-production-8955.up.railway.app/v1/discovery/raw?serviceType=legacy",
    signer_headers: {
      Authorization:
        "Bearer app_abcdef0123456789abcdef01_pmth_deadbeef",
    },
  });
});

test("buildLivepeerPythonSdkTokenPayload omits discovery when unset", () => {
  const payload = buildLivepeerPythonSdkTokenPayload({
    apiKey: "app_x_pmth_y",
    signer: "https://signer.example",
    discovery: null,
  });
  assert.equal(payload.discovery, undefined);
  assert.equal(payload.signer, "https://signer.example");
});

test("encodeLivepeerPythonSdkToken round-trips via base64 JSON", () => {
  const payload = buildLivepeerPythonSdkTokenPayload({
    apiKey: "app_9adb48bd0123456789abcdef_pmth_d20bf6fc",
    signer: "https://pymthouse-production.up.railway.app/",
    discovery:
      "https://discovery-service-production-8955.up.railway.app/v1/discovery/raw?serviceType=legacy",
  });
  const encoded = encodeLivepeerPythonSdkToken(payload);
  const decoded = JSON.parse(
    Buffer.from(encoded, "base64").toString("utf8"),
  ) as typeof payload;
  assert.deepEqual(decoded, payload);
});

test("createLivepeerPythonSdkToken returns base64 string", () => {
  const token = createLivepeerPythonSdkToken({
    apiKey: "app_a_pmth_b",
    signer: "https://signer.example",
    discovery: "https://discovery.example/v1",
  });
  assert.match(token, /^[A-Za-z0-9+/=]+$/);
  const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  assert.equal(decoded.signer_headers.Authorization, "Bearer app_a_pmth_b");
});

test("getLivepeerPythonSdkDiscoveryUrl prefers DISCOVERY_URL over ORCH_WEBHOOK_URL", () => {
  withEnv(
    {
      DISCOVERY_URL: "https://discovery.example/preferred",
      ORCH_WEBHOOK_URL: "https://orch.example/fallback",
    },
    () => {
      assert.equal(
        getLivepeerPythonSdkDiscoveryUrl(),
        "https://discovery.example/preferred",
      );
    },
  );
});

test("getLivepeerPythonSdkDiscoveryUrl falls back to ORCH_WEBHOOK_URL", () => {
  withEnv(
    {
      DISCOVERY_URL: undefined,
      ORCH_WEBHOOK_URL:
        "https://discovery-service-production-8955.up.railway.app/v1/discovery/raw?serviceType=legacy",
    },
    () => {
      assert.equal(
        getLivepeerPythonSdkDiscoveryUrl(),
        "https://discovery-service-production-8955.up.railway.app/v1/discovery/raw?serviceType=legacy",
      );
    },
  );
});
