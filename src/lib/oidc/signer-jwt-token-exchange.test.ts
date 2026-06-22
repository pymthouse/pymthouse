import test from "node:test";
import assert from "node:assert/strict";

import {
  handleSignerJwtTokenExchange,
  isSignerJwtTokenExchangeRequest,
  SUBJECT_ACCESS_TOKEN_TYPE,
  type SignerJwtTokenExchangeDeps,
} from "./signer-jwt-token-exchange";
import { signerJwtAudience } from "./mint-user-signer-token";
import type { DrizzleDb } from "./client-sibling";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const M2M_ID = "m2m_test123";
const PUBLIC_ID = "app_testpublic";

const m2mRowOk = {
  id: "int-m2m",
  clientSecretHash: "hash",
  allowedScopes: "users:token sign:job",
  clientId: M2M_ID,
};

/** Single `db.select().from().where().limit()` for the caller `oidcClients` lookup. */
function dbMock(rows: unknown[][]): DrizzleDb {
  let i = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const r = rows[i++];
            if (!r) throw new Error(`db mock exhausted at step ${i}`);
            return Promise.resolve(r);
          },
        }),
      }),
    }),
  } as unknown as DrizzleDb;
}

const happyDeps: Partial<SignerJwtTokenExchangeDeps> = {
  validateClientSecret: async () => true,
  resolveDeveloperAppAndPublicClientForOidcRow: async () => ({
    developerAppId: "dev-app-1",
    publicClientId: PUBLIC_ID,
  }),
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
    balanceUsdMicros: "4200000",
    lifetimeGrantedUsdMicros: "5000000",
  }),
};

test("isSignerJwtTokenExchangeRequest is true when resource targets the signer audience", () => {
  assert.equal(
    isSignerJwtTokenExchangeRequest({
      grantType: TOKEN_EXCHANGE_GRANT,
      subjectTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
      resource: signerJwtAudience(),
    }),
    true,
  );
});

test("handleSignerJwtTokenExchange sets issued_token_type (RFC 8693 §2.2.1)", async () => {
  const out = await handleSignerJwtTokenExchange(
    {
      clientId: M2M_ID,
      clientSecret: "secret",
      subjectToken: "jwt",
      subjectTokenType: SUBJECT_ACCESS_TOKEN_TYPE,
      resource: signerJwtAudience(),
    },
    {
      ...happyDeps,
      db: dbMock([[m2mRowOk]]),
    },
  );

  assert.equal(out.access_token, "eyJ.signer.jwt");
  assert.equal(
    out.issued_token_type,
    "urn:ietf:params:oauth:token-type:access_token",
  );
  assert.equal(out.balanceUsdMicros, "4200000");
});
