import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptedSignerAudiences,
  AppScopedSignerTokenExchangeError,
  GRANT_TYPE_TOKEN_EXCHANGE,
  handleAppScopedSignerTokenExchange,
  handleIssuerApiKeySignerTokenExchange,
  isAcceptedApiKeySubjectTokenType,
  isApiKeySubjectTokenType,
  looksLikeAppApiKeySubjectToken,
  resolveAppScopedSubjectToken,
  SUBJECT_ACCESS_TOKEN_TYPE,
  SUBJECT_API_KEY_TOKEN_TYPE,
  validateOptionalM2mClient,
  validateRequestedTokenType,
  validateSignerTarget,
} from "./app-scoped-signer-token-exchange";
import { signerJwtAudience } from "./mint-user-signer-token";

const PUBLIC_ID = "app_3b386c81a1db1169fd2c3986";

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
  await assert.doesNotReject(async () => validateOptionalM2mClient("", ""));
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

test("resolveAppScopedSubjectToken accepts composite app_*_* via resolveActiveAppApiKey", async () => {
  const secret = "a".repeat(64);
  const composite = `${PUBLIC_ID}_${secret}`;
  const resolved = await resolveAppScopedSubjectToken(composite, PUBLIC_ID, {
    resolveActiveAppApiKey: async (token, publicClientId) => {
      assert.equal(token, composite);
      assert.equal(publicClientId, PUBLIC_ID);
      return {
        apiKeyId: "key-1",
        developerAppId: "dev-1",
        publicClientId: PUBLIC_ID,
        appUserId: "au-1",
        externalUserId: "ext-1",
        label: null,
      };
    },
  });
  assert.equal(resolved.externalUserId, "ext-1");
  assert.equal(resolved.publicClientId, PUBLIC_ID);
});

test("resolveAppScopedSubjectToken rejects composite with mismatched app_ prefix", async () => {
  await assert.rejects(
    () =>
      resolveAppScopedSubjectToken(
        `app_aaaaaaaaaaaaaaaaaaaaaaaa_${"b".repeat(64)}`,
        PUBLIC_ID,
        {
          resolveActiveAppApiKey: async () => null,
        },
      ),
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
  let signerUrlAppId: string | undefined;
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
      getClientSignerApiUrl: (appClientId) => {
        signerUrlAppId = appClientId ?? undefined;
        return "https://signer.example";
      },
      loadAppUserDiscoveryUrl: async () => undefined,
    },
  );

  assert.equal(session.access_token, "eyJ.signer.jwt");
  assert.equal(session.issued_token_type, SUBJECT_ACCESS_TOKEN_TYPE);
  assert.equal(session.correlation_id, "corr-1");
  assert.equal(session.balanceUsdMicros, "1000000");
  assert.equal(session.signer_url, "https://signer.example");
  assert.equal(
    session.discovery_url,
    "https://signer.example/discover-orchestrators",
  );
  // Signer version is selected per app: the subject's public client id must flow
  // into getClientSignerApiUrl so LATEST_SIGNER_APPS routing applies.
  assert.equal(signerUrlAppId, PUBLIC_ID);
});

test("handleAppScopedSignerTokenExchange accepts discovery_url and caps overrides", async () => {
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
      correlationId: "corr-override",
      discovery_url: "https://custom.example/discover-orchestrators",
      caps: [" live-video-to-video/streamdiffusion ", "text-to-image/flux"],
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
        balanceUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      }),
      getClientSignerApiUrl: () => "https://signer.example",
      loadAppUserDiscoveryUrl: async () =>
        "https://pref.example/discover-orchestrators",
    },
  );

  assert.equal(
    session.discovery_url,
    "https://custom.example/discover-orchestrators",
  );
  assert.deepEqual(session.caps, [
    "live-video-to-video/streamdiffusion",
    "text-to-image/flux",
  ]);
});

test("handleAppScopedSignerTokenExchange uses user discoveryUrl preference", async () => {
  let loadedFor: { appId: string; externalUserId: string } | undefined;
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
      correlationId: "corr-pref",
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
        balanceUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      }),
      getClientSignerApiUrl: () => "https://signer.example",
      loadAppUserDiscoveryUrl: async (input) => {
        loadedFor = input;
        return "https://pref.example/discover-orchestrators";
      },
    },
  );

  assert.deepEqual(loadedFor, {
    appId: "dev-app-1",
    externalUserId: "ext-1",
  });
  assert.equal(
    session.discovery_url,
    "https://pref.example/discover-orchestrators",
  );
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
      loadAppUserDiscoveryUrl: async () => undefined,
    },
  );

  assert.equal(session.access_token, "eyJ.signer.jwt");
});

test("looksLikeAppApiKeySubjectToken accepts bare pmth_ and composite", () => {
  assert.equal(looksLikeAppApiKeySubjectToken("pmth_abc"), true);
  assert.equal(
    looksLikeAppApiKeySubjectToken(`${PUBLIC_ID}_${"a".repeat(64)}`),
    true,
  );
  assert.equal(looksLikeAppApiKeySubjectToken("a".repeat(64)), true);
  assert.equal(looksLikeAppApiKeySubjectToken("pmth_cs_secret"), false);
  assert.equal(looksLikeAppApiKeySubjectToken("header.payload.sig"), false);
});

test("handleIssuerApiKeySignerTokenExchange resolves app from bare pmth_ subject", async () => {
  const bare = "pmth_7c3d2ae03dcca8cfa04223523301b8b29f81a883294492c7e07a2333cb3d24d5";
  const session = await handleIssuerApiKeySignerTokenExchange(
    {
      clientId: "",
      clientSecret: "",
      grantType: GRANT_TYPE_TOKEN_EXCHANGE,
      subjectToken: bare,
      subjectTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
      requestedTokenType: "",
      resource: "",
      audiences: [],
      correlationId: "corr-issuer",
    },
    {
      resolveActiveAppApiKeyFromBearer: async (token) => {
        assert.equal(token, bare);
        return {
          apiKeyId: "key-1",
          developerAppId: "dev-app-1",
          publicClientId: PUBLIC_ID,
          appUserId: "au-1",
          externalUserId: "ext-1",
          label: null,
        };
      },
      resolveActiveAppApiKey: async () => ({
        apiKeyId: "key-1",
        developerAppId: "dev-app-1",
        publicClientId: PUBLIC_ID,
        appUserId: "au-1",
        externalUserId: "ext-1",
        label: null,
      }),
      mintSignerJwtForExternalUser: async (input) => {
        assert.equal(input.publicClientId, PUBLIC_ID);
        assert.equal(input.externalUserId, "ext-1");
        return {
          access_token: "eyJ.personal.signer",
          token_type: "Bearer" as const,
          expires_in: 300,
          scope: "sign:job",
          balanceUsdMicros: "0",
          lifetimeGrantedUsdMicros: "0",
        };
      },
      getClientSignerApiUrl: () => "https://signer.example",
      loadAppUserDiscoveryUrl: async () => undefined,
    },
  );

  assert.equal(session.access_token, "eyJ.personal.signer");
  assert.equal(session.token_type, "Bearer");
  assert.equal(session.issued_token_type, SUBJECT_ACCESS_TOKEN_TYPE);
  assert.equal(session.correlation_id, "corr-issuer");
  assert.equal(
    session.discovery_url,
    "https://signer.example/discover-orchestrators",
  );
});

test("handleIssuerApiKeySignerTokenExchange rejects unknown bare key", async () => {
  await assert.rejects(
    () =>
      handleIssuerApiKeySignerTokenExchange(
        {
          clientId: "",
          clientSecret: "",
          grantType: GRANT_TYPE_TOKEN_EXCHANGE,
          subjectToken: "pmth_deadbeef",
          subjectTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
          requestedTokenType: "",
          resource: "",
          audiences: [],
          correlationId: "corr-miss",
        },
        {
          resolveActiveAppApiKeyFromBearer: async () => null,
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "invalid_grant");
      return true;
    },
  );
});

test("isApiKeySubjectTokenType recognizes canonical URI only", () => {
  assert.equal(isApiKeySubjectTokenType(SUBJECT_API_KEY_TOKEN_TYPE), true);
  assert.equal(isApiKeySubjectTokenType(SUBJECT_ACCESS_TOKEN_TYPE), false);
  assert.equal(isAcceptedApiKeySubjectTokenType(SUBJECT_API_KEY_TOKEN_TYPE), true);
  assert.equal(isAcceptedApiKeySubjectTokenType(SUBJECT_ACCESS_TOKEN_TYPE), true);
  assert.equal(
    isAcceptedApiKeySubjectTokenType("urn:ietf:params:oauth:token-type:jwt"),
    false,
  );
});

test("handleAppScopedSignerTokenExchange accepts canonical api_key type", async () => {
  const session = await handleAppScopedSignerTokenExchange(
    {
      publicClientId: PUBLIC_ID,
      clientId: "",
      clientSecret: "",
      grantType: GRANT_TYPE_TOKEN_EXCHANGE,
      subjectToken: "pmth_abc123",
      subjectTokenType: SUBJECT_API_KEY_TOKEN_TYPE,
      requestedTokenType: "",
      resource: "",
      audiences: [],
      correlationId: "corr-api-key-type",
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
        balanceUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      }),
      getClientSignerApiUrl: () => "https://signer.example",
      loadAppUserDiscoveryUrl: async () => undefined,
    },
  );

  assert.equal(session.access_token, "eyJ.signer.jwt");
  assert.equal(session.correlation_id, "corr-api-key-type");
});

test("handleAppScopedSignerTokenExchange rejects api_key type with JWT-shaped subject", async () => {
  await assert.rejects(
    () =>
      handleAppScopedSignerTokenExchange({
        publicClientId: PUBLIC_ID,
        clientId: "",
        clientSecret: "",
        grantType: GRANT_TYPE_TOKEN_EXCHANGE,
        subjectToken: "header.payload.sig",
        subjectTokenType: SUBJECT_API_KEY_TOKEN_TYPE,
        requestedTokenType: "",
        resource: "",
        audiences: [],
        correlationId: "corr-jwt-as-key",
      }),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "invalid_grant");
      return true;
    },
  );
});

test("handleAppScopedSignerTokenExchange rejects unknown subject_token_type", async () => {
  await assert.rejects(
    () =>
      handleAppScopedSignerTokenExchange({
        publicClientId: PUBLIC_ID,
        clientId: "",
        clientSecret: "",
        grantType: GRANT_TYPE_TOKEN_EXCHANGE,
        subjectToken: "pmth_abc123",
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
        requestedTokenType: "",
        resource: "",
        audiences: [],
        correlationId: "corr-bad-type",
      }),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "unsupported_token_type");
      return true;
    },
  );
});

test("handleIssuerApiKeySignerTokenExchange accepts canonical api_key type", async () => {
  const bare = "pmth_7c3d2ae03dcca8cfa04223523301b8b29f81a883294492c7e07a2333cb3d24d5";
  const session = await handleIssuerApiKeySignerTokenExchange(
    {
      clientId: "",
      clientSecret: "",
      grantType: GRANT_TYPE_TOKEN_EXCHANGE,
      subjectToken: bare,
      subjectTokenType: SUBJECT_API_KEY_TOKEN_TYPE,
      requestedTokenType: "",
      resource: "",
      audiences: [],
      correlationId: "corr-issuer-canonical",
    },
    {
      resolveActiveAppApiKeyFromBearer: async () => ({
        apiKeyId: "key-1",
        developerAppId: "dev-app-1",
        publicClientId: PUBLIC_ID,
        appUserId: "au-1",
        externalUserId: "ext-1",
        label: null,
      }),
      resolveActiveAppApiKey: async () => ({
        apiKeyId: "key-1",
        developerAppId: "dev-app-1",
        publicClientId: PUBLIC_ID,
        appUserId: "au-1",
        externalUserId: "ext-1",
        label: null,
      }),
      mintSignerJwtForExternalUser: async () => ({
        access_token: "eyJ.personal.signer",
        token_type: "Bearer" as const,
        expires_in: 300,
        scope: "sign:job",
        balanceUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      }),
      getClientSignerApiUrl: () => "https://signer.example",
      loadAppUserDiscoveryUrl: async () => undefined,
    },
  );

  assert.equal(session.access_token, "eyJ.personal.signer");
});

test("handleIssuerApiKeySignerTokenExchange rejects unsupported subject_token_type", async () => {
  await assert.rejects(
    () =>
      handleIssuerApiKeySignerTokenExchange({
        clientId: "",
        clientSecret: "",
        grantType: GRANT_TYPE_TOKEN_EXCHANGE,
        subjectToken: "pmth_abc",
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
        requestedTokenType: "",
        resource: "",
        audiences: [],
        correlationId: "corr-issuer-bad-type",
      }),
    (err: unknown) => {
      assert.ok(err instanceof AppScopedSignerTokenExchangeError);
      assert.equal(err.code, "unsupported_token_type");
      return true;
    },
  );
});
