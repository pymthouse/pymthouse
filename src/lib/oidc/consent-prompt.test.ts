import assert from "node:assert/strict";

import { test } from "node:test";

import {
  consentPromptNeeded,
  promptIncludesConsent,
  requestedScopesList,
} from "./consent-prompt";

test("requestedScopesList trims and drops empties", () => {
  assert.deepEqual(requestedScopesList([" openid", "", "admin "]), [
    "openid",
    "admin",
  ]);
  assert.deepEqual(requestedScopesList(undefined), []);
});

test("consentPromptNeeded is true when no grant id is present", async () => {
  const needed = await consentPromptNeeded({
    requestedScopes: ["openid", "admin"],
    findGrant: async () => {
      throw new Error("should not load a grant");
    },
  });
  assert.equal(needed, true);
});

test("consentPromptNeeded uses result.consent grantId before session", async () => {
  const needed = await consentPromptNeeded({
    requestedScopes: ["openid", "profile", "admin"],
    resultConsentGrantId: "g_result",
    sessionGrantId: "g_session",
    findGrant: async (id) => {
      assert.equal(id, "g_result");
      return {
        getOIDCScope: () => "openid profile email admin",
      };
    },
  });
  assert.equal(needed, false);
});

test("consentPromptNeeded is true when granted scopes do not cover the request", async () => {
  const needed = await consentPromptNeeded({
    requestedScopes: ["openid", "admin"],
    sessionGrantId: "g1",
    findGrant: async () => ({
      getOIDCScope: () => "openid profile",
    }),
  });
  assert.equal(needed, true);
});

test("promptIncludesConsent reads the OIDC prompt parameter", () => {
  assert.equal(promptIncludesConsent("consent"), true);
  assert.equal(promptIncludesConsent("login consent"), true);
  assert.equal(promptIncludesConsent("login"), false);
  assert.equal(promptIncludesConsent(["login", "consent"]), true);
  assert.equal(promptIncludesConsent(undefined), false);
});

test("consentPromptNeeded is true for prompt=consent until this request grants", async () => {
  const needed = await consentPromptNeeded({
    requestedScopes: ["openid"],
    sessionGrantId: "g_session",
    forceConsent: true,
    findGrant: async () => ({
      getOIDCScope: () => "openid profile email offline_access sign:job",
    }),
  });
  assert.equal(needed, true);
});

test("consentPromptNeeded is false for prompt=consent after this request grants", async () => {
  const needed = await consentPromptNeeded({
    requestedScopes: ["openid"],
    resultConsentGrantId: "g_result",
    forceConsent: true,
    findGrant: async () => ({
      getOIDCScope: () => "openid",
    }),
  });
  assert.equal(needed, false);
});

test("consentPromptNeeded is true when the session grant belongs to another account", async () => {
  const needed = await consentPromptNeeded({
    requestedScopes: ["openid"],
    sessionGrantId: "g_session",
    accountId: "user-2",
    findGrant: async () => ({
      accountId: "user-1",
      getOIDCScope: () => "openid",
    }),
  });
  assert.equal(needed, true);
});

test("consentPromptNeeded is true when the grant row is missing", async () => {
  const needed = await consentPromptNeeded({
    requestedScopes: ["openid"],
    resultConsentGrantId: "missing",
    findGrant: async () => undefined,
  });
  assert.equal(needed, true);
});
