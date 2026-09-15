import assert from "node:assert/strict";
import test from "node:test";

import { hasClientConfigUpdates, parseAppCoreUpdate } from "./app-core";

test("parseAppCoreUpdate collects app field updates", () => {
  const parsed = parseAppCoreUpdate(
    {
      name: "New Name",
      description: "Desc",
      backendDeviceHelper: true,
    },
    null,
  );
  assert.equal(parsed.appUpdates.name, "New Name");
  assert.equal(parsed.appUpdates.description, "Desc");
  assert.equal(parsed.backendDeviceHelper, true);
});

test("parseAppCoreUpdate filters allowed scopes and augments users:token when required", () => {
  const parsed = parseAppCoreUpdate(
    {
      allowedScopes: "openid invalid",
      grantTypes: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
    },
    {
      allowedScopes: "openid profile",
      grantTypes: "authorization_code,urn:ietf:params:oauth:grant-type:device_code",
      initiateLoginUri: "https://example.com/login",
      deviceThirdPartyInitiateLogin: 1,
    },
  );
  assert.equal(parsed.clientUpdates.allowedScopes, "openid users:token");
});

test("hasClientConfigUpdates reflects whether any client fields changed", () => {
  assert.equal(hasClientConfigUpdates({}), false);
  assert.equal(hasClientConfigUpdates({ displayName: "App" }), true);
});
