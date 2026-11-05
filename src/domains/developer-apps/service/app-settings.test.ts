import assert from "node:assert/strict";
import test from "node:test";

import {
  extractOrigins,
  maybeAugmentAllowedScopesForDeviceFlow,
  normalizeOriginsToDomains,
  validateDeviceInitiateLoginSettings,
} from "./app-settings";

test("validateDeviceInitiateLoginSettings requires URI when device login is enabled", () => {
  const result = validateDeviceInitiateLoginSettings({
    initiateLoginUri: null,
    deviceThirdPartyInitiateLogin: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error, "invalid_request");
});

test("maybeAugmentAllowedScopesForDeviceFlow adds users:token when device flow needs it", () => {
  const result = maybeAugmentAllowedScopesForDeviceFlow({
    allowedScopes: "openid profile",
    grantTypes: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
    initiateLoginUri: "https://example.com/login",
    deviceThirdPartyInitiateLogin: true,
  });
  assert.equal(result, "openid profile users:token");
});

test("extractOrigins dedupes valid origins", () => {
  const origins = extractOrigins([
    "https://example.com/callback",
    "https://example.com/logout",
    "http://localhost:3000/callback",
  ]);
  assert.deepEqual(origins.sort(), ["http://localhost:3000", "https://example.com"]);
});

test("normalizeOriginsToDomains returns canonical origins", () => {
  const domains = normalizeOriginsToDomains([
    "https://example.com",
    "http://localhost:3000",
  ]);
  assert.deepEqual(domains.sort(), ["http://localhost:3000", "https://example.com"]);
});
