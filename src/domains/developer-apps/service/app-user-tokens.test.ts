import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRequestedProgrammaticScopes,
  validateProgrammaticScopes,
  validateProgrammaticTokenRequest,
} from "./app-user-tokens";

test("parseRequestedProgrammaticScopes defaults to sign:job", () => {
  assert.deepEqual(parseRequestedProgrammaticScopes({}), ["sign:job"]);
});

test("validateProgrammaticTokenRequest rejects missing auth", () => {
  const result = validateProgrammaticTokenRequest({
    authenticatedClient: null,
    requestedClientId: "app_1",
    correlationId: "corr",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 401);
});

test("validateProgrammaticScopes rejects admin scope", () => {
  const result = validateProgrammaticScopes({
    requestedScopes: ["admin"],
    publicAllowedScopes: "openid sign:job users:token",
    correlationId: "corr",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 400);
});
