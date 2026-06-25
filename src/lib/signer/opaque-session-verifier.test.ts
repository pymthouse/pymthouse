import assert from "node:assert/strict";
import test from "node:test";

import {
  createFirstMatchEndUserVerifier,
  handleRemoteSignerAuthorize,
  type EndUserAuthVerifier,
  type PaymentWebhookResponse,
} from "@pymthouse/builder-sdk/signer/webhook";

import {
  createOpaqueSessionEndUserVerifier,
  type OpaqueSessionPrincipal,
} from "./opaque-session-verifier";

const ISSUER = "https://pymthouse.example/api/v1/oidc";
const OPAQUE_TOKEN = "pmth_deadbeefdeadbeefdeadbeefdeadbeef";
const JWT_TOKEN = "header.payload.signature";

function principal(
  overrides: Partial<OpaqueSessionPrincipal> = {},
): OpaqueSessionPrincipal {
  return {
    clientId: "app_client_123",
    externalUserId: "user-42",
    ...overrides,
  };
}

test("opaque session is accepted with symmetric attribution identity", async () => {
  const verifier = createOpaqueSessionEndUserVerifier({
    issuer: ISSUER,
    resolvePrincipal: async (token) => {
      assert.equal(token, OPAQUE_TOKEN);
      return principal();
    },
  });

  const before = Math.trunc(Date.now() / 1000);
  const result = await verifier.verify({
    authorization: `Bearer ${OPAQUE_TOKEN}`,
    payload: {},
    request: new Request("https://signer.invalid/authorize"),
  });

  assert.deepEqual(result.identity, {
    issuer: ISSUER,
    client_id: "app_client_123",
    usage_subject: "user-42",
    usage_subject_type: "external_user_id",
  });
  assert.ok(result.expiry > before, "expiry must be in the future");
});

test("issuer trailing slashes are stripped to match signer JWT aud", async () => {
  const verifier = createOpaqueSessionEndUserVerifier({
    issuer: `${ISSUER}//`,
    resolvePrincipal: async () => principal(),
  });

  const result = await verifier.verify({
    authorization: `Bearer ${OPAQUE_TOKEN}`,
    payload: {},
    request: new Request("https://signer.invalid/authorize"),
  });

  assert.equal(result.identity.issuer, ISSUER);
});

test("non-opaque bearer is passed through (throws so JWT path runs)", async () => {
  let resolverCalled = false;
  const verifier = createOpaqueSessionEndUserVerifier({
    issuer: ISSUER,
    resolvePrincipal: async () => {
      resolverCalled = true;
      return principal();
    },
  });

  await assert.rejects(
    verifier.verify({
      authorization: `Bearer ${JWT_TOKEN}`,
      payload: {},
      request: new Request("https://signer.invalid/authorize"),
    }),
  );
  assert.equal(resolverCalled, false, "JWTs must not hit the session resolver");
});

test("forged/expired opaque session is rejected", async () => {
  const verifier = createOpaqueSessionEndUserVerifier({
    issuer: ISSUER,
    resolvePrincipal: async () => null,
  });

  await assert.rejects(
    verifier.verify({
      authorization: `Bearer ${OPAQUE_TOKEN}`,
      payload: {},
      request: new Request("https://signer.invalid/authorize"),
    }),
  );
});

// --- Composite / webhook integration (mirrors the route wiring) ---------------

const WEBHOOK_SECRET = "test-webhook-secret";

/** Stub OIDC verifier standing in for the unchanged JWT path. */
function jwtStubVerifier(): EndUserAuthVerifier {
  return {
    kind: "oidc",
    verify: async ({ authorization }) => {
      if (authorization !== `Bearer ${JWT_TOKEN}`) {
        throw new Error("Invalid JWT");
      }
      return {
        identity: {
          issuer: ISSUER,
          client_id: "app_client_jwt",
          usage_subject: "user-jwt",
          usage_subject_type: "external_user_id",
        },
        expiry: Math.trunc(Date.now() / 1000) + 300,
      };
    },
  };
}

function webhookRequest(bearer: string): Request {
  return new Request("https://signer.invalid/authorize", {
    method: "POST",
    headers: {
      authorization: `Bearer ${WEBHOOK_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ authorization: `Bearer ${bearer}` }),
  });
}

function webhookConfig(resolve: (t: string) => Promise<OpaqueSessionPrincipal | null>) {
  return {
    webhookSecret: WEBHOOK_SECRET,
    endUserAuth: createFirstMatchEndUserVerifier([
      createOpaqueSessionEndUserVerifier({ issuer: ISSUER, resolvePrincipal: resolve }),
      jwtStubVerifier(),
    ]),
  };
}

test("webhook: opaque session authorizes /generate-live-payment with attribution", async () => {
  const response = await handleRemoteSignerAuthorize(
    webhookRequest(OPAQUE_TOKEN),
    webhookConfig(async () => principal()),
  );
  const body = (await response.json()) as PaymentWebhookResponse;

  assert.equal(response.status, 200);
  assert.equal(body.status, 200);
  assert.deepEqual(body.identity, {
    issuer: ISSUER,
    client_id: "app_client_123",
    usage_subject: "user-42",
    usage_subject_type: "external_user_id",
  });
  assert.equal(body.auth_id, "app_client_123:user-42");
});

test("webhook: JWT bearer still authorizes via the unchanged JWT path", async () => {
  const response = await handleRemoteSignerAuthorize(
    webhookRequest(JWT_TOKEN),
    webhookConfig(async () => {
      throw new Error("opaque resolver must not run for JWTs");
    }),
  );
  const body = (await response.json()) as PaymentWebhookResponse;

  assert.equal(body.status, 200);
  assert.equal(body.identity?.client_id, "app_client_jwt");
});

test("webhook: forged opaque session is rejected", async () => {
  const response = await handleRemoteSignerAuthorize(
    webhookRequest(OPAQUE_TOKEN),
    webhookConfig(async () => null),
  );
  const body = (await response.json()) as PaymentWebhookResponse;

  // go-livepeer reads `status` from the body; a non-200 status denies the ticket.
  assert.notEqual(body.status, 200);
  assert.equal(body.identity, undefined);
});
