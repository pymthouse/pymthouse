import test from "node:test";
import assert from "node:assert/strict";
import {
  bearerToken,
  handleAuthorize,
  WebhookError,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";
import { createLegacyWebhookConfigFromEnv } from "@pymthouse/clearinghouse-identity-webhook/legacy-env";

const WEBHOOK_SECRET = "test-webhook-secret";
const JWT_ISSUER = "https://pymthouse.com/api/v1/oidc";

function buildLegacyWebhookConfig(env) {
  return createLegacyWebhookConfigFromEnv(env, {
    jwtIssuer: env.JWT_ISSUER?.trim() || JWT_ISSUER,
  });
}

function parseCompositeAppApiKeyBearer(token) {
  const trimmed = token.trim();
  const separator = ".pmth_";
  const idx = trimmed.indexOf(separator);
  if (idx <= 0) {
    return null;
  }
  const publicClientId = trimmed.slice(0, idx).trim();
  const secretSuffix = trimmed.slice(idx + separator.length).trim();
  if (!publicClientId.startsWith("app_") || !secretSuffix) {
    return null;
  }
  return {
    publicClientId,
    pmthSecret: `pmth_${secretSuffix}`,
  };
}

function createFirstMatchEndUserVerifier(verifiers) {
  return {
    kind: "composite",
    verify: async (context) => {
      let lastError;
      for (const verifier of verifiers) {
        try {
          return await verifier.verify(context);
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError instanceof WebhookError) {
        throw lastError;
      }
      if (lastError instanceof Error) {
        throw new WebhookError(lastError.message, {
          status: 401,
          code: "invalid_credentials",
        });
      }
      throw new WebhookError("authorization rejected", { status: 403 });
    },
  };
}

function createCompositeAppApiKeyVerifier({ issuer, resolveActiveAppApiKey }) {
  return {
    kind: "composite_app_api_key",
    verify: async ({ authorization }) => {
      const token = bearerToken(authorization);
      const parts = parseCompositeAppApiKeyBearer(token);
      if (!parts) {
        throw new Error("not a composite app API key bearer");
      }

      const resolved = await resolveActiveAppApiKey(
        parts.pmthSecret,
        parts.publicClientId,
      );
      if (!resolved) {
        throw new Error("invalid or unauthorized composite app API key");
      }

      return {
        identity: {
          issuer,
          client_id: resolved.publicClientId,
          usage_subject: resolved.externalUserId,
          usage_subject_type: "external_user_id",
        },
        expiry: Math.trunc(Date.now() / 1000) + 300,
      };
    },
  };
}

test("remote-signer webhook config requires WEBHOOK_SECRET", () => {
  assert.throws(
    () =>
      buildLegacyWebhookConfig({
        JWT_ISSUER: JWT_ISSUER,
      }),
    /WEBHOOK_SECRET is required/,
  );
});

test("remote-signer webhook accepts composite app.pmth_ bearer", async () => {
  const config = {
    webhookSecret: WEBHOOK_SECRET,
    endUserAuth: createFirstMatchEndUserVerifier([
      createCompositeAppApiKeyVerifier({
        issuer: JWT_ISSUER,
        resolveActiveAppApiKey: async (pmthSecret, publicClientId) => {
          assert.equal(pmthSecret, "pmth_secretpart");
          assert.equal(publicClientId, "app_fixture");
          return {
            publicClientId: "app_fixture",
            externalUserId: "ext-user-1",
          };
        },
      }),
    ]),
  };

  const request = new Request("http://localhost/webhooks/remote-signer", {
    method: "POST",
    headers: {
      authorization: `Bearer ${WEBHOOK_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      headers: { Authorization: ["Bearer app_fixture.pmth_secretpart"] },
    }),
  });

  const response = await handleAuthorize(request, config);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 200);
  assert.equal(body.auth_id, "app_fixture:ext-user-1");
  assert.deepEqual(body.identity, {
    issuer: JWT_ISSUER,
    client_id: "app_fixture",
    usage_subject: "ext-user-1",
    usage_subject_type: "external_user_id",
  });
});

test("remote-signer webhook rejects unauthorized caller", async () => {
  const config = buildLegacyWebhookConfig({
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
  const config = buildLegacyWebhookConfig({
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
