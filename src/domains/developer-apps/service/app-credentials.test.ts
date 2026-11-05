import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveSecretRotationTarget,
  validateSecretRotationClient,
} from "./app-credentials";

test("resolveSecretRotationTarget rejects apps without a configured OIDC client", () => {
  const result = resolveSecretRotationTarget({
    oidcClientId: null,
    m2mOidcClientId: null,
    primaryClient: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 400);
  assert.equal(result.ok ? "" : result.body.error, "App has no OIDC client configured");
});

test("resolveSecretRotationTarget prefers the backend helper client when present", () => {
  const result = resolveSecretRotationTarget({
    oidcClientId: "public-row",
    m2mOidcClientId: "m2m-row",
    primaryClient: null,
  });
  assert.deepEqual(result, { ok: true, value: "m2m-row" });
});

test("resolveSecretRotationTarget rejects public interactive clients without a backend helper", () => {
  const result = resolveSecretRotationTarget({
    oidcClientId: "public-row",
    m2mOidcClientId: null,
    primaryClient: {
      id: "public-row",
      clientId: "app_public",
      tokenEndpointAuthMethod: "none",
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 400);
  assert.equal(result.ok ? "" : result.body.error, "interactive_public_no_secret");
});

test("validateSecretRotationClient rejects public clients", () => {
  const result = validateSecretRotationClient({
    id: "public-row",
    clientId: "app_public",
    tokenEndpointAuthMethod: "none",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.status, 400);
  assert.equal(result.ok ? "" : result.body.error, "public_client_no_secret");
});

test("validateSecretRotationClient returns confidential clients", () => {
  const result = validateSecretRotationClient({
    id: "m2m-row",
    clientId: "m2m_public",
    tokenEndpointAuthMethod: "client_secret_basic",
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.clientId : "", "m2m_public");
});
