import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptedSignerAudiences,
  AppScopedSignerTokenExchangeError,
  GRANT_TYPE_TOKEN_EXCHANGE,
  handleAppScopedSignerTokenExchange,
  resolveAppScopedSubjectToken,
  SUBJECT_ACCESS_TOKEN_TYPE,
  validateOptionalM2mClient,
  validateRequestedTokenType,
  validateSignerTarget,
} from "./app-scoped-signer-token-exchange";
import { signerJwtAudience } from "./mint-user-signer-token";

const PUBLIC_ID = "app_testpublic";

test("validateRequestedTokenType accepts omitted or access_token", () => {
  assert.doesNotThrow(() => validateRequestedTokenType(""));
  assert.doesNotThrow(() =>
    validateRequestedTokenType("urn:ietf:params:oauth:token-type:access_token"),
  );
});

test("validateRequestedTokenType rejects other types", () => {
  assert.throws(
    () => validateRequestedTokenType("urn:ietf:params:oauth:token-type:jwt"),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "invalid_request");
      return true;
    },
  );
});

test("validateSignerTarget allows omitted audience and resource", () => {
  assert.doesNotThrow(() => validateSignerTarget("", []));
});

test("validateSignerTarget accepts issuer URL and legacy aliases", () => {
  const issuer = signerJwtAudience();
  assert.doesNotThrow(() => validateSignerTarget(issuer, []));
  assert.doesNotThrow(() => validateSignerTarget("", ["livepeer-clearinghouse"]));
  assert.doesNotThrow(() => validateSignerTarget("", ["livepeer-remote-signer"]));
});

test("validateSignerTarget rejects unknown audience", () => {
  assert.throws(
    () => validateSignerTarget("", ["https://unknown.example/aud"]),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "invalid_target");
      return true;
    },
  );
});

test("acceptedSignerAudiences includes issuer and legacy values", () => {
  const audiences = acceptedSignerAudiences();
  assert.ok(audiences.has(signerJwtAudience()));
  assert.ok(audiences.has("livepeer-clearinghouse"));
  assert.ok(audiences.has("livepeer-remote-signer"));
});

test("validateOptionalM2mClient allows empty credentials", async () => {
  await validateOptionalM2mClient("", "");
});

test("validateOptionalM2mClient rejects partial credentials", async () => {
  await assert.rejects(
    () => validateOptionalM2mClient("m2m_x", ""),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "invalid_client");
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("resolveAppScopedSubjectToken rejects non-jwt non-api-key tokens", async () => {
  await assert.rejects(
    () => resolveAppScopedSubjectToken("not-a-token", PUBLIC_ID),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "invalid_grant");
      return true;
    },
  );
});

test("resolveAppScopedSubjectToken rejects pmth_cs_* client secrets as subject_token", async () => {
  await assert.rejects(
    () => resolveAppScopedSubjectToken("pmth_cs_secretvalue123", PUBLIC_ID),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "invalid_grant");
      return true;
    },
  );
});

test("handleAppScopedSignerTokenExchange rejects wrong grant_type", async () => {
  await assert.rejects(
    () =>
      handleAppScopedSignerTokenExchange({
        publicClientId: PUBLIC_ID,
        clientId: "",
        clientSecret: "",
        grantType: "client_credentials",
        subjectToken: "pmth_test",
        subjectTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
        requestedTokenType: "",
        resource: "",
        audiences: [],
        correlationId: "corr-test",
      }),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "invalid_request");
      return true;
    },
  );
});

test("handleAppScopedSignerTokenExchange mints signer session from API key subject", async () => {
  const session = await handleAppScopedSignerTokenExchange(
    {
      publicClientId: PUBLIC_ID,
      clientId: "",
      clientSecret: "",
      grantType: GRANT_TYPE_TOKEN_EXCHANGE,
      subjectToken: "pmth_abc123",
      subjectTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
      requestedTokenType: "",
      resource: "",
      audiences: [],
      correlationId: "corr-1",
    },
    {
      resolveActiveAppApiKey: async () => ({
        apiKeyId: "key-1",
        developerAppId: "dev-app-1",
        publicClientId: PUBLIC_ID,
        appUserId: "au-1",
        externalUserId: "ext-1",
        label: null,
      }),
      mintSignerJwtForExternalUser: async () => ({
        access_token: "eyJ.signer.jwt",
        token_type: "Bearer" as const,
        expires_in: 300,
        scope: "sign:job",
        balanceUsdMicros: "1000000",
        lifetimeGrantedUsdMicros: "5000000",
      }),
      getClientSignerApiUrl: () => "https://signer.example",
      getSignerDiscoveryUrl: () => "https://discovery.example/v1/discovery",
    },
  );

  assert.equal(session.access_token, "eyJ.signer.jwt");
  assert.equal(session.issued_token_type, SUBJECT_ACCESS_TOKEN_TYPE);
  assert.equal(session.correlation_id, "corr-1");
  assert.equal(session.balanceUsdMicros, "1000000");
  assert.equal(session.signer_url, "https://signer.example");
  assert.equal(session.discovery_url, "https://discovery.example/v1/discovery");
});

test("handleAppScopedSignerTokenExchange mints from user JWT with sign:job scope", async () => {
  const session = await handleAppScopedSignerTokenExchange(
    {
      publicClientId: PUBLIC_ID,
      clientId: "",
      clientSecret: "",
      grantType: GRANT_TYPE_TOKEN_EXCHANGE,
      subjectToken: "header.payload.sig",
      subjectTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
      requestedTokenType: "",
      resource: signerJwtAudience(),
      audiences: [],
      correlationId: "corr-jwt",
    },
    {
      resolveSubjectAccessToken: async () => ({
        payload: { scope: "sign:job" },
        sub: "au-1",
        publicClientId: PUBLIC_ID,
        developerAppId: "dev-app-1",
        externalUserId: "ext-1",
      }),
      mintSignerJwtForExternalUser: async () => ({
        access_token: "eyJ.signer.jwt",
        token_type: "Bearer" as const,
        expires_in: 300,
        scope: "sign:job",
        balanceUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      }),
      getClientSignerApiUrl: () => undefined as unknown as string,
      getSignerDiscoveryUrl: () => undefined,
    },
  );

  assert.equal(session.access_token, "eyJ.signer.jwt");
});
