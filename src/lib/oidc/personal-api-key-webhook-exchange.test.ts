import test from "node:test";
import assert from "node:assert/strict";

import {
  REMOTE_SIGNER_ERROR_CODE,
  REMOTE_SIGNER_HTTP_STATUS,
  WebhookError,
  type EndUserAuthVerifier,
} from "@pymthouse/clearinghouse-identity-webhook/protocol";

import {
  AppScopedSignerTokenExchangeError,
  SUBJECT_API_KEY_TOKEN_TYPE,
} from "@/lib/oidc/app-scoped-signer-token-exchange";
import {
  isBarePersonalApiKeyBearer,
  webhookErrorFromPersonalApiKeyExchange,
  withPersonalApiKeyExchange,
} from "@/lib/oidc/personal-api-key-webhook-exchange";

const PUBLIC_ID = "app_444013b9d984f62f5572a282";
const BARE_KEY = "pmth_28daa486391e5366261107f8175c2cfcba01a12940fd86d99d6f72ee1532a57b";
const COMPOSITE_KEY = `${PUBLIC_ID}_${BARE_KEY}`;

function stubVerifier(
  verify: EndUserAuthVerifier["verify"],
): EndUserAuthVerifier {
  return { kind: "oidc", verify };
}

function verifyInput(authorization: string) {
  return {
    authorization,
    payload: {},
    request: new Request("http://localhost/webhooks/remote-signer"),
  };
}

test("isBarePersonalApiKeyBearer accepts stored pmth_ keys only", () => {
  assert.equal(isBarePersonalApiKeyBearer(BARE_KEY), true);
  assert.equal(isBarePersonalApiKeyBearer(` ${BARE_KEY} `), true);
  assert.equal(isBarePersonalApiKeyBearer(COMPOSITE_KEY), false);
  assert.equal(isBarePersonalApiKeyBearer("pmth_cs_notanapikey"), false);
  assert.equal(isBarePersonalApiKeyBearer("eyJhbGciOiJSUzI1NiJ9.e30.sig"), false);
  assert.equal(isBarePersonalApiKeyBearer(""), false);
});

test("webhookErrorFromPersonalApiKeyExchange maps billing and grant failures", () => {
  const billing = webhookErrorFromPersonalApiKeyExchange(
    new AppScopedSignerTokenExchangeError(
      "billing_unavailable",
      "billing balance unavailable",
      503,
    ),
  );
  assert.equal(billing.status, REMOTE_SIGNER_HTTP_STATUS.BILLING_UNAVAILABLE);
  assert.equal(billing.code, REMOTE_SIGNER_ERROR_CODE.BILLING_UNAVAILABLE);

  const exhausted = webhookErrorFromPersonalApiKeyExchange(
    new AppScopedSignerTokenExchangeError(
      "trial_credits_exhausted",
      "out of credit",
      402,
    ),
  );
  assert.equal(exhausted.status, REMOTE_SIGNER_HTTP_STATUS.INSUFFICIENT_BALANCE);
  assert.equal(exhausted.code, REMOTE_SIGNER_ERROR_CODE.INSUFFICIENT_BALANCE);

  const unknown = webhookErrorFromPersonalApiKeyExchange(
    new AppScopedSignerTokenExchangeError(
      "invalid_grant",
      "subject_token is not a valid API key for this issuer",
    ),
  );
  assert.equal(unknown.status, 401);
  assert.equal(unknown.code, "invalid_token");
});

test("withPersonalApiKeyExchange passes JWTs and composite keys through", async () => {
  const seen: string[] = [];
  const inner = stubVerifier(async ({ authorization }) => {
    seen.push(authorization);
    return {
      identity: {
        issuer: "https://idp.example/api/v1/oidc",
        client_id: PUBLIC_ID,
        usage_subject: "user-1",
        usage_subject_type: "external_user_id",
      },
      expiry: Math.floor(Date.now() / 1000) + 60,
    };
  });

  const wrapped = withPersonalApiKeyExchange(inner, {
    exchange: async () => {
      throw new Error("issuer exchange must not run for JWT or composite");
    },
  });

  await wrapped.verify(verifyInput("Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig"));
  await wrapped.verify(verifyInput(`Bearer ${COMPOSITE_KEY}`));
  assert.deepEqual(seen, [
    "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig",
    `Bearer ${COMPOSITE_KEY}`,
  ]);
});

test("withPersonalApiKeyExchange exchanges a bare personal key then verifies the JWT", async () => {
  const minted = "eyJhbGciOiJSUzI1NiJ9.e30.minted";
  let exchangeCalls = 0;
  const inner = stubVerifier(async ({ authorization }) => {
    assert.equal(authorization, `Bearer ${minted}`);
    return {
      identity: {
        issuer: "https://idp.example/api/v1/oidc",
        client_id: PUBLIC_ID,
        usage_subject: "user-456",
        usage_subject_type: "external_user_id",
      },
      expiry: Math.floor(Date.now() / 1000) + 120,
    };
  });

  const wrapped = withPersonalApiKeyExchange(inner, {
    exchange: async (input) => {
      exchangeCalls += 1;
      assert.equal(input.subjectToken, BARE_KEY);
      assert.equal(input.subjectTokenType, SUBJECT_API_KEY_TOKEN_TYPE);
      return {
        access_token: minted,
        token_type: "Bearer",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        expires_in: 300,
        scope: "sign:job",
        balanceUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      };
    },
  });

  const first = await wrapped.verify(verifyInput(`Bearer ${BARE_KEY}`));
  const second = await wrapped.verify(verifyInput(`Bearer ${BARE_KEY}`));
  assert.equal(first.identity.usage_subject, "user-456");
  assert.equal(first.identity.client_id, PUBLIC_ID);
  assert.equal(second.identity.usage_subject, "user-456");
  assert.equal(exchangeCalls, 1);
});

test("withPersonalApiKeyExchange maps unknown personal keys to invalid_token", async () => {
  const inner = stubVerifier(async () => {
    throw new Error("inner verifier must not run when exchange fails");
  });
  const wrapped = withPersonalApiKeyExchange(inner, {
    exchange: async () => {
      throw new AppScopedSignerTokenExchangeError(
        "invalid_grant",
        "subject_token is not a valid API key for this issuer",
      );
    },
  });

  await assert.rejects(
    () => wrapped.verify(verifyInput(`Bearer ${BARE_KEY}`)),
    (err: unknown) => {
      assert.ok(err instanceof WebhookError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "invalid_token");
      assert.match(err.message, /not a valid API key/);
      return true;
    },
  );
});
