import test from "node:test";
import assert from "node:assert/strict";
import { handleAuthorize } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createLegacyWebhookConfigFromEnv } from "@pymthouse/clearinghouse-identity-webhook/legacy-env";

const WEBHOOK_SECRET = "test-webhook-secret";
const JWT_ISSUER = "https://pymthouse.com/api/v1/oidc";

function buildWebhookConfig(env) {
  return createLegacyWebhookConfigFromEnv(env, {
    jwtIssuer: env.JWT_ISSUER?.trim() || JWT_ISSUER,
  });
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

test("remote-signer webhook authorizes composite app_*.pmth_* via mocked exchange", async () => {
  const { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } = await import("jose");
  const { createOidcVerifier } = await import(
    "@pymthouse/clearinghouse-identity-webhook/verifiers"
  );

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "pymthouse-test";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const clientId = "app_abc123";
  const minted = await new SignJWT({
    client_id: clientId,
    external_user_id: "user-456",
    scope: "sign:job",
  })
    .setProtectedHeader({ alg: "RS256", kid: "pymthouse-test" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const fetchImpl = async (input) => {
    const url = String(input);
    assert.ok(url.includes(`/api/v1/apps/${clientId}/oidc/token`));
    return Response.json({ access_token: minted, expires_in: 300 });
  };

  const config = {
    webhookSecret: WEBHOOK_SECRET,
    endUserAuth: createOidcVerifier({
      jwtIssuer: JWT_ISSUER,
      jwtAudience: JWT_ISSUER,
      issuer: JWT_ISSUER,
      jwks,
      clientClaim: "client_id",
      subjectClaim: "external_user_id",
      subjectTypeValue: "external_user_id",
      requiredScopes: ["sign:job"],
      tokenExchangeBaseUrl: "http://localhost:3000",
      fetchImpl,
    }),
  };

  const request = new Request("http://localhost/webhooks/remote-signer", {
    method: "POST",
    headers: {
      authorization: `Bearer ${WEBHOOK_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      headers: { Authorization: [`Bearer ${clientId}.pmth_deadbeef`] },
    }),
  });

  const response = await handleAuthorize(request, config);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 200);
  assert.equal(body.auth_id, "app_abc123:user-456");
});
