import test from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_SCOPES,
  assertSignJobNotMixedWithAdmin,
  SignJobScopeExclusivityError,
  SIGN_MINT_USER_TOKEN_SCOPE,
  toProviderScopeMetadata,
} from "./scopes";

test("ADMIN_SCOPES includes admin paths but not sign:job or openid", () => {
  assert.ok(ADMIN_SCOPES.has("users:write"));
  assert.ok(ADMIN_SCOPES.has(SIGN_MINT_USER_TOKEN_SCOPE));
  assert.ok(ADMIN_SCOPES.has("device:approve"));
  assert.equal(ADMIN_SCOPES.has("sign:job"), false);
  assert.equal(ADMIN_SCOPES.has("openid"), false);
});

test("assertSignJobNotMixedWithAdmin allows sign:job alone", () => {
  assert.doesNotThrow(() => assertSignJobNotMixedWithAdmin(["sign:job"]));
});

test("assertSignJobNotMixedWithAdmin allows admin scopes without sign:job", () => {
  assert.doesNotThrow(() =>
    assertSignJobNotMixedWithAdmin(["users:write", "users:token"]),
  );
});

test("assertSignJobNotMixedWithAdmin rejects sign:job mixed with admin scopes", () => {
  assert.throws(
    () => assertSignJobNotMixedWithAdmin(["sign:job", "users:write"]),
    SignJobScopeExclusivityError,
  );
  assert.throws(
    () => assertSignJobNotMixedWithAdmin(["sign:job", SIGN_MINT_USER_TOKEN_SCOPE]),
    SignJobScopeExclusivityError,
  );
});

test("toProviderScopeMetadata strips sign:mint_user_token for public clients", () => {
  assert.equal(
    toProviderScopeMetadata("openid sign:job sign:mint_user_token", "app_abc"),
    "openid sign:job",
  );
});

test("toProviderScopeMetadata strips mint and sign:job for m2m clients", () => {
  assert.equal(
    toProviderScopeMetadata(
      "sign:mint_user_token sign:job users:write users:token device:approve",
      "m2m_abc",
    ),
    "users:write users:token device:approve",
  );
});
