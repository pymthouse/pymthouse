import test from "node:test";
import assert from "node:assert/strict";
import { handleAuthorize } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createLegacyWebhookConfigFromEnv } from "@pymthouse/clearinghouse-identity-webhook/legacy-env";

const WEBHOOK_SECRET = "test-webhook-secret";
const JWT_ISSUER = "https://pymthouse.com/api/v1/oidc";

/** Mirror route.ts: pymthouse serves JWKS at {issuer}/jwks, not /.well-known/jwks.json. */
function buildWebhookConfig(env) {
  const jwtIssuer = env.JWT_ISSUER?.trim() || JWT_ISSUER;
  const jwksUri =
    env.OIDC_JWKS_URI?.trim() || env.JWKS_URI?.trim() || `${jwtIssuer}/jwks`;
  return createLegacyWebhookConfigFromEnv(
    { ...env, OIDC_JWKS_URI: jwksUri },
    { jwtIssuer },
  );
}

test("remote-signer webhook config requires WEBHOOK_SECRET", () => {
  assert.throws(
    () =>
      buildWebhookConfig({
        JWT_ISSUER: JWT_ISSUER,
      }),
    /WEBHOOK_SECRET is required/,
  );
});

test("remote-signer webhook rejects unauthorized caller", async () => {
  const config = buildWebhookConfig({
    WEBHOOK_SECRET,
    JWT_ISSUER,
  });

  const request = new Request("http://localhost/webhooks/remote-signer", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      headers: { Authorization: ["Bearer fake-end-user-token"] },
    }),
  });

  const response = await handleAuthorize(request, config);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.status, 401);
  assert.equal(body.reason, "unauthorized webhook caller");
});

test("remote-signer webhook rejects invalid request json", async () => {
  const config = buildWebhookConfig({
    WEBHOOK_SECRET,
    JWT_ISSUER,
  });

  const request = new Request("http://localhost/webhooks/remote-signer", {
    method: "POST",
    headers: {
      authorization: `Bearer ${WEBHOOK_SECRET}`,
      "content-type": "application/json",
    },
    body: "not-json",
  });

  const response = await handleAuthorize(request, config);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.status, 400);
  assert.equal(body.reason, "invalid request json");
});

test("remote-signer webhook JWKS path is issuer/jwks", () => {
  const jwtIssuer = JWT_ISSUER;
  const jwksUri = `${jwtIssuer}/jwks`;
  assert.equal(jwksUri, "https://pymthouse.com/api/v1/oidc/jwks");
  assert.notEqual(jwksUri, `${jwtIssuer}/.well-known/jwks.json`);
  // Config builds without throwing when OIDC_JWKS_URI is set to pymthouse path.
  const config = buildWebhookConfig({
    WEBHOOK_SECRET,
    JWT_ISSUER,
    OIDC_JWKS_URI: jwksUri,
  });
  assert.equal(config.endUserAuth.kind, "oidc");
});
