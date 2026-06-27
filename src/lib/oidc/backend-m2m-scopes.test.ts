import test from "node:test";
import assert from "node:assert/strict";

import {
  computeBackendM2mAllowedScopes,
  computeBackendM2mClientCredentialsScopes,
  publicAppAllowsSignJob,
  scopeForClientCredentialsRequest,
} from "./backend-m2m-scopes";

test("computeBackendM2mAllowedScopes adds sign:mint_user_token when public has sign:job", () => {
  const scopes = computeBackendM2mAllowedScopes("openid sign:job");
  assert.match(scopes, /sign:mint_user_token/);
  assert.match(scopes, /sign:job/);
});

test("scopeForClientCredentialsRequest strips mint-only scopes", () => {
  assert.equal(
    scopeForClientCredentialsRequest(
      "sign:mint_user_token sign:job users:write users:token device:approve",
    ),
    "users:write users:token device:approve",
  );
});

test("computeBackendM2mClientCredentialsScopes omits signer mint and sign:job", () => {
  const scopes = computeBackendM2mClientCredentialsScopes("openid sign:job");
  assert.doesNotMatch(scopes, /sign:mint_user_token/);
  assert.doesNotMatch(scopes, /sign:job/);
  assert.match(scopes, /users:write/);
  assert.match(scopes, /users:token/);
  assert.match(scopes, /device:approve/);
});

test("publicAppAllowsSignJob detects sign:job in public scopes", () => {
  assert.equal(publicAppAllowsSignJob("openid sign:job users:read"), true);
  assert.equal(publicAppAllowsSignJob("openid users:read"), false);
});
