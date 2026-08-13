import assert from "node:assert/strict";

import { test } from "node:test";

import {
  consentPromptNeeded,
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

test("consentPromptNeeded is true when the grant row is missing", async () => {
  const needed = await consentPromptNeeded({
    requestedScopes: ["openid"],
    resultConsentGrantId: "missing",
    findGrant: async () => undefined,
  });
  assert.equal(needed, true);
});
