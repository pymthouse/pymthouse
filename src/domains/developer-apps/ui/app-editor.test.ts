import assert from "node:assert/strict";
import test from "node:test";

import {
  createSettingsFormData,
  createWizardFormData,
  defaultAppFormData,
  getAppStatusInfo,
  mapAppDetailToEditorModel,
} from "@/domains/developer-apps/ui/app-editor";

test("createWizardFormData clones arrays and overlays initial data", () => {
  const initial = {
    name: "My App",
    grantTypes: ["authorization_code"],
    redirectUris: ["https://rp.example/callback"],
  };

  const formData = createWizardFormData(initial);
  assert.equal(formData.name, "My App");
  assert.deepEqual(formData.grantTypes, ["authorization_code"]);
  assert.deepEqual(formData.redirectUris, ["https://rp.example/callback"]);

  formData.grantTypes.push("refresh_token");
  formData.redirectUris.push("https://rp.example/other");

  assert.deepEqual(initial.grantTypes, ["authorization_code"]);
  assert.deepEqual(initial.redirectUris, ["https://rp.example/callback"]);
});

test("createSettingsFormData prefers explicit initial values over fallback settings", () => {
  const formData = createSettingsFormData(
    {
      backendDeviceHelper: true,
      initiateLoginUri: "https://rp.example/login",
      deviceThirdPartyInitiateLogin: false,
      grantTypes: ["client_credentials"],
    },
    "https://ignored.example/login",
    true,
  );

  assert.equal(formData.backendDeviceHelper, true);
  assert.equal(formData.initiateLoginUri, "https://rp.example/login");
  assert.equal(formData.deviceThirdPartyInitiateLogin, false);
  assert.deepEqual(formData.grantTypes, ["client_credentials"]);
});

test("mapAppDetailToEditorModel shapes API detail into editor state", () => {
  const model = mapAppDetailToEditorModel({
    id: "app_123",
    name: "Provider App",
    description: "App description",
    developerName: "Example Co",
    websiteUrl: "https://example.com",
    status: "approved",
    canEdit: true,
    canSubmitForReview: false,
    domains: [{ id: "d1", domain: "https://app.example.com" }],
    m2mOidcClient: { clientId: "m2m_123", hasSecret: true },
    oidcClient: {
      clientId: "app_client_123",
      redirectUris: ["https://rp.example/callback"],
      allowedScopes: "openid sign:job users:read",
      grantTypes: "authorization_code,refresh_token",
      tokenEndpointAuthMethod: "client_secret_basic",
      hasSecret: true,
      postLogoutRedirectUris: ["https://rp.example/logout"],
      initiateLoginUri: "https://rp.example/login",
      deviceThirdPartyInitiateLogin: true,
    },
  });

  assert.equal(model.formData.name, "Provider App");
  assert.deepEqual(model.formData.redirectUris, ["https://rp.example/callback"]);
  assert.deepEqual(model.formData.grantTypes, ["authorization_code", "refresh_token"]);
  assert.equal(model.formData.tokenEndpointAuthMethod, "client_secret_basic");
  assert.equal(model.formData.backendDeviceHelper, true);
  assert.equal(model.state.clientId, "app_client_123");
  assert.deepEqual(model.state.backendHelper, { clientId: "m2m_123", hasSecret: true });
  assert.deepEqual(model.domains, [{ id: "d1", domain: "https://app.example.com" }]);
  assert.deepEqual(model.postLogoutRedirectUris, ["https://rp.example/logout"]);
  assert.equal(model.initiateLoginUri, "https://rp.example/login");
  assert.equal(model.deviceThirdPartyInitiateLogin, true);
  assert.equal(model.canEdit, true);
  assert.equal(model.canSubmitForReview, false);
});

test("getAppStatusInfo falls back to draft for unknown statuses", () => {
  assert.deepEqual(getAppStatusInfo("approved"), {
    label: "Approved",
    color: "bg-emerald-500/20 text-emerald-400",
  });
  assert.deepEqual(getAppStatusInfo("does-not-exist"), {
    label: "Draft",
    color: "bg-zinc-700 text-zinc-300",
  });
  assert.equal(defaultAppFormData.backendDeviceHelper, true);
});
