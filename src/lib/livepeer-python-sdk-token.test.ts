import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLivepeerPythonSdkTokenPayload,
  createLivepeerPythonSdkToken,
  encodeLivepeerPythonSdkToken,
  getLivepeerPythonSdkDiscoveryUrl,
} from "@/lib/livepeer-python-sdk-token";

test("buildLivepeerPythonSdkTokenPayload defaults discovery to signer discover-orchestrators", () => {
  const payload = buildLivepeerPythonSdkTokenPayload({
    apiKey: "app_abcdef0123456789abcdef01_pmth_deadbeef",
    signer: "https://signer.pymthouse.com/",
  });

  assert.deepEqual(payload, {
    signer: "https://signer.pymthouse.com/",
    discovery: "https://signer.pymthouse.com/discover-orchestrators",
    signer_headers: {
      Authorization:
        "Bearer app_abcdef0123456789abcdef01_pmth_deadbeef",
    },
  });
});

test("buildLivepeerPythonSdkTokenPayload omits discovery when null", () => {
  const payload = buildLivepeerPythonSdkTokenPayload({
    apiKey: "app_x_pmth_y",
    signer: "https://signer.example",
    discovery: null,
  });
  assert.equal(payload.discovery, undefined);
  assert.equal(payload.signer, "https://signer.example");
});

test("buildLivepeerPythonSdkTokenPayload includes caps when provided", () => {
  const payload = buildLivepeerPythonSdkTokenPayload({
    apiKey: "app_x_pmth_y",
    signer: "https://signer.example",
    caps: [" live-video-to-video/streamdiffusion ", "text-to-image/flux"],
  });
  assert.deepEqual(payload.caps, [
    "live-video-to-video/streamdiffusion",
    "text-to-image/flux",
  ]);
});

test("encodeLivepeerPythonSdkToken round-trips via base64 JSON", () => {
  const payload = buildLivepeerPythonSdkTokenPayload({
    apiKey: "app_9adb48bd0123456789abcdef_pmth_d20bf6fc",
    signer: "https://signer.pymthouse.com/",
    caps: ["live-video-to-video/scope"],
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
    discovery: "https://custom.example/discover-orchestrators",
  });
  assert.match(token, /^[A-Za-z0-9+/=]+$/);
  const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  assert.equal(decoded.signer_headers.Authorization, "Bearer app_a_pmth_b");
  assert.equal(
    decoded.discovery,
    "https://custom.example/discover-orchestrators",
  );
});

test("getLivepeerPythonSdkDiscoveryUrl derives from signer URL", () => {
  assert.equal(
    getLivepeerPythonSdkDiscoveryUrl("https://signer.example/"),
    "https://signer.example/discover-orchestrators",
  );
});
