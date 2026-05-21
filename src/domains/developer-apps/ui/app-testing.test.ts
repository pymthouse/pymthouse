import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAppTestingModel,
  getDefaultRedirectUri,
} from "@/domains/developer-apps/ui/app-testing";

test("getDefaultRedirectUri prefers the first HTTP(S) redirect", () => {
  assert.equal(
    getDefaultRedirectUri(["com.example.app:/callback", "https://app.example/callback"]),
    "https://app.example/callback",
  );
  assert.equal(getDefaultRedirectUri(["custom://callback"]), "custom://callback");
  assert.equal(getDefaultRedirectUri([]), "");
});

test("buildAppTestingModel builds auth-code flow URLs and human labels", () => {
  const model = buildAppTestingModel({
    origin: "https://pymthouse.example",
    clientId: "app_client_123",
    grantTypes: ["authorization_code", "refresh_token"],
    redirectUris: ["https://rp.example/callback"],
    allowedScopes: "openid sign:job users:read invalid-scope",
    backendHelper: { clientId: "m2m_client_456", hasSecret: true },
    selectedRedirectUri: "https://rp.example/callback",
  });

  assert.equal(model.hasAuthCodeFlow, true);
  assert.equal(model.isM2MOnly, false);
  assert.equal(model.discoveryUrl, "https://pymthouse.example/.well-known/openid-configuration");
  assert.deepEqual(model.selectedScopes, ["OpenID", "Sign Jobs", "Read Users"]);
  assert.ok(model.testUrl);
  assert.match(model.testUrl!, /^https:\/\/pymthouse\.example\/api\/v1\/oidc\/authorize\?/);
  assert.match(model.testUrl!, /client_id=app_client_123/);
  assert.match(model.testUrl!, /redirect_uri=https%3A%2F%2Frp\.example%2Fcallback/);
  assert.match(model.testUrl!, /scope=openid\+sign%3Ajob\+users%3Aread/);
  assert.match(model.m2mCurlSnippet, /client_id=m2m_client_456/);
  assert.match(
    model.backendHelperCurlSnippet,
    /scope=sign:job users:read users:write users:token device:approve/,
  );
});

test("buildAppTestingModel uses the public client for M2M-only apps", () => {
  const model = buildAppTestingModel({
    origin: "https://pymthouse.example",
    clientId: "public_m2m_client",
    grantTypes: ["client_credentials"],
    redirectUris: [],
    allowedScopes: "openid sign:job",
    backendHelper: { clientId: "helper_client", hasSecret: true },
    selectedRedirectUri: "",
  });

  assert.equal(model.hasAuthCodeFlow, false);
  assert.equal(model.isM2MOnly, true);
  assert.equal(model.testUrl, null);
  assert.match(model.m2mCurlSnippet, /client_id=public_m2m_client/);
  assert.match(model.m2mCurlSnippet, /scope=sign:job/);
});

test("buildAppTestingModel falls back when no valid client scopes remain", () => {
  const model = buildAppTestingModel({
    origin: "https://pymthouse.example",
    clientId: "app_client_123",
    grantTypes: ["client_credentials"],
    redirectUris: [],
    allowedScopes: "openid not-real-scope",
    backendHelper: null,
    selectedRedirectUri: "",
  });

  assert.match(model.m2mCurlSnippet, /scope=YOUR_CONFIGURED_SCOPES/);
  assert.equal(model.backendHelperCurlSnippet, "");
});
