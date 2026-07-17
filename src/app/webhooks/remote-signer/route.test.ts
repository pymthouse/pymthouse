import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { handleAuthorize } from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createOidcVerifier } from "@pymthouse/clearinghouse-identity-webhook/verifiers";
import { buildRemoteSignerWebhookConfig } from "@/lib/oidc/remote-signer-webhook-config";

const WEBHOOK_SECRET = "test-webhook-secret";
const OIDC_ISSUER = "https://pymthouse.com/api/v1/oidc";

/** Minimal env — claim/issuer defaults come from resolveIdentityWebhookEnv. */
const CANONICAL_OIDC_ENV = {
  NEXTAUTH_URL: "https://pymthouse.com",
} as const;

function buildWebhookConfig(env: Record<string, string | undefined> = {}) {
  return buildRemoteSignerWebhookConfig({
    ...CANONICAL_OIDC_ENV,
    ...env,
  });
}

test("remote-signer webhook config leaves WEBHOOK_SECRET empty when unset", () => {
  const config = buildWebhookConfig();
  assert.equal(config.webhookSecret, "");
  assert.equal(config.endUserAuth.kind, "composite");
});

test("remote-signer webhook rejects unauthorized caller", async () => {
  const config = buildWebhookConfig({
    WEBHOOK_SECRET,
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

test("remote-signer webhook authorizes composite app_*_* via mocked exchange", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "pymthouse-test";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const clientId = "app_3b386c81a1db1169fd2c3986";
  const minted = await new SignJWT({
    client_id: clientId,
    external_user_id: "user-456",
    scope: "sign:job",
  })
    .setProtectedHeader({ alg: "RS256", kid: "pymthouse-test" })
    .setIssuer(OIDC_ISSUER)
    .setAudience(OIDC_ISSUER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    assert.ok(url.includes(`/api/v1/apps/${clientId}/oidc/token`));
    return Response.json({ access_token: minted, expires_in: 300 });
  };

  const config = {
    webhookSecret: WEBHOOK_SECRET,
    endUserAuth: createOidcVerifier({
      jwtIssuer: OIDC_ISSUER,
      jwtAudience: OIDC_ISSUER,
      issuer: OIDC_ISSUER,
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
      headers: { Authorization: [`Bearer ${clientId}_deadbeef`] },
    }),
  });

  const response = await handleAuthorize(request, config);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 200);
  assert.equal(body.auth_id, "app_3b386c81a1db1169fd2c3986:user-456");
});
