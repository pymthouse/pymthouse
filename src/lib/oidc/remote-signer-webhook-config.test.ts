import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteSignerWebhookConfig,
  resolveIdentityWebhookEnv,
} from "@/lib/oidc/remote-signer-webhook-config";

const ORIGIN = "https://idp.example";
const ISSUER = `${ORIGIN}/api/v1/oidc`;

test("resolveIdentityWebhookEnv defaults from NEXTAUTH_URL alone", () => {
  const resolved = resolveIdentityWebhookEnv({
    NEXTAUTH_URL: ORIGIN,
  });

  assert.equal(resolved.IDENTITY_AUTH_MODE, "oidc");
  assert.equal(resolved.IDENTITY_ISSUER, ISSUER);
  assert.equal(resolved.OIDC_ISSUER, ISSUER);
  assert.equal(resolved.OIDC_AUDIENCE, ISSUER);
  assert.equal(resolved.OIDC_CLIENT_CLAIM, "client_id");
  assert.equal(resolved.OIDC_SUBJECT_CLAIM, "external_user_id");
  assert.equal(resolved.OIDC_SUBJECT_TYPE, "external_user_id");
  assert.equal(resolved.OIDC_REQUIRED_SCOPES, "sign:job");
  assert.equal(resolved.OIDC_TOKEN_EXCHANGE_BASE_URL, ORIGIN);
});

test("resolveIdentityWebhookEnv prefers IDENTITY_ISSUER over OIDC_ISSUER", () => {
  const resolved = resolveIdentityWebhookEnv({
    IDENTITY_ISSUER: ISSUER,
    OIDC_ISSUER: "https://legacy.example/api/v1/oidc",
    OIDC_AUDIENCE: "custom-aud",
    OIDC_CLIENT_CLAIM: "azp",
  });

  assert.equal(resolved.IDENTITY_ISSUER, ISSUER);
  assert.equal(resolved.OIDC_ISSUER, "https://legacy.example/api/v1/oidc");
  assert.equal(resolved.OIDC_AUDIENCE, "custom-aud");
  assert.equal(resolved.OIDC_CLIENT_CLAIM, "azp");
});

test("resolveIdentityWebhookEnv upgrades http IDENTITY_ISSUER for public hosts", () => {
  const resolved = resolveIdentityWebhookEnv({
    IDENTITY_ISSUER: ORIGIN.replace("https://", "http://"),
  });

  assert.equal(resolved.IDENTITY_ISSUER, ISSUER);
});

test("resolveIdentityWebhookEnv keeps http for localhost", () => {
  const resolved = resolveIdentityWebhookEnv({
    NEXTAUTH_URL: "http://localhost:3001",
  });

  assert.equal(resolved.IDENTITY_ISSUER, "http://localhost:3001/api/v1/oidc");
});

test("buildRemoteSignerWebhookConfig works with NEXTAUTH_URL only", () => {
  const config = buildRemoteSignerWebhookConfig({
    NEXTAUTH_URL: ORIGIN,
    WEBHOOK_SECRET: "secret",
  });
  assert.equal(config.webhookSecret, "secret");
  assert.equal(config.endUserAuth.kind, "oidc");
});
