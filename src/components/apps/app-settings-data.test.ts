import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheLoadedApp,
  loadedAppFromApiPayload,
  peekLoadedApp,
} from "./app-settings-data";

test("loadedAppFromApiPayload maps API fields and defaults", () => {
  const loaded = loadedAppFromApiPayload({
    id: "app_1",
    name: "Demo",
    status: "active",
    ownerId: " user_1 ",
    canEdit: true,
    canDeleteApp: true,
    canManageBilling: false,
    oidcClient: {
      clientId: "app_1",
      allowedScopes: "openid",
      grantTypes: "authorization_code,refresh_token",
      tokenEndpointAuthMethod: "none",
      hasSecret: false,
      postLogoutRedirectUris: ["https://app.example/out"],
      initiateLoginUri: "https://app.example/login",
      deviceThirdPartyInitiateLogin: true,
    },
    m2mOidcClient: { clientId: "m2m_1", hasSecret: true },
    webOidcClient: {
      clientId: "web_1",
      hasSecret: true,
      redirectUris: ["https://app.example/cb"],
    },
    domains: [{ id: "d1", domain: "https://app.example" }],
  });

  assert.equal(loaded.formData.name, "Demo");
  assert.deepEqual(loaded.formData.grantTypes, [
    "authorization_code",
    "refresh_token",
  ]);
  assert.equal(loaded.formData.backendDeviceHelper, true);
  assert.equal(loaded.formData.confidentialWebHelper, true);
  assert.deepEqual(loaded.formData.confidentialWebRedirectUris, [
    "https://app.example/cb",
  ]);
  assert.equal(loaded.state.clientId, "app_1");
  assert.equal(loaded.state.backendHelper?.clientId, "m2m_1");
  assert.equal(loaded.canEdit, true);
  assert.equal(loaded.canManageBilling, false);
  assert.equal(loaded.ownerExternalUserId, "user_1");
  assert.deepEqual(loaded.postLogoutRedirectUris, ["https://app.example/out"]);
  assert.equal(loaded.deviceThirdPartyInitiateLogin, true);
});

test("peekLoadedApp returns the cached app for an id", () => {
  const loaded = loadedAppFromApiPayload({
    id: "app_cache",
    name: "Cached",
    status: "active",
  });
  cacheLoadedApp("app_cache", loaded);
  assert.equal(peekLoadedApp("app_cache")?.formData.name, "Cached");
  assert.equal(peekLoadedApp("app_missing"), null);
});
