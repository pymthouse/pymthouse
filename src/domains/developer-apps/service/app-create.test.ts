import assert from "node:assert/strict";
import test from "node:test";

import { parseAppCreateInput } from "./app-create";

test("parseAppCreateInput requires a name", () => {
  const result = parseAppCreateInput({});
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.body.error, "App name is required");
});

test("parseAppCreateInput normalizes create input and augments users:token", () => {
  const result = parseAppCreateInput({
    name: " My App ",
    redirectUris: [" https://example.com/callback "],
    allowedScopes: "openid invalid",
    grantTypes: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
    deviceThirdPartyInitiateLogin: true,
    initiateLoginUri: "https://example.com/login",
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.name : "", "My App");
  assert.deepEqual(result.ok ? result.value.clientUpdates.redirectUris : [], [
    "https://example.com/callback",
  ]);
  assert.equal(result.ok ? result.value.clientUpdates.allowedScopes : "", "openid users:token");
});
