import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  handleDeviceApprovalTokenExchange,
  isDeviceApprovalTokenExchangeRequest,
  type DrizzleDb,
} from "./device-token-exchange";
import { TokenExchangeError } from "./token-exchange";
import { getIssuer } from "./issuer-urls";

function dbMock(rows: unknown[][]): DrizzleDb {
  let i = 0;
  const next = () => {
    const r = rows[i++];
    if (!r) throw new Error(`db mock exhausted at step ${i}`);
    return Promise.resolve(r);
  };
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => next(),
        }),
      }),
    }),
  } as unknown as DrizzleDb;
}

/** Fails fast if any DB read runs (e.g. invalid client secret path must not query). */
const dbMockSelectForbidden: DrizzleDb = {
  select: () => {
    throw new Error("unexpected db.select — validateClientSecret should short-circuit first");
  },
} as unknown as DrizzleDb;

const M2M_ID = "m2m_test123";
const PUBLIC_ID = "app_testpublic";
const SUBJECT_JWT = randomUUID();

const m2mRowOk = {
  id: "int-m2m",
  clientSecretHash: "hash",
  allowedScopes: "users:token device:approve",
  clientId: M2M_ID,
};

// dbMock consumes rows in strict call order; each entry is the next `.limit()` result:
// 0: oidcClients by M2M client_id
// 1: developerApps sibling (public oidc row id)
// 2: oidcClients.id → client_id (resolvePublicClientIdForOidcRow)
// 3: oidcClients by public client_id — { id, deviceThirdPartyInitiateLogin } (single merged query)
// 4: developerApps by oidcClientId
// 5: appUsers by subject_token.sub
function rowsForHappyPath(): unknown[][] {
  return [
    [m2mRowOk],
    [{ oidcClientId: "pub-int" }],
    [{ clientId: PUBLIC_ID }],
    [{ id: "pub-int", deviceThirdPartyInitiateLogin: 1 }],
    [{ id: "dev-app-1" }],
    [{ externalUserId: "ext-user-1" }],
  ];
}

function baseJwtPayload() {
  const exp = Math.floor(Date.now() / 1000) + 900;
  return {
    sub: "account-1",
    client_id: PUBLIC_ID,
    exp,
    scope: "sign:job",
  };
}

async function rejectsWithCode(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof TokenExchangeError);
    assert.equal((err as TokenExchangeError).code, code);
    return true;
  });
}

test("isDeviceApprovalTokenExchangeRequest is true for device resource + token exchange + access_token subject type", () => {
  assert.equal(
    isDeviceApprovalTokenExchangeRequest({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
      resource: "urn:pmth:device_code:ABCD-EFGH",
    }),
    true,
  );
});

test("isDeviceApprovalTokenExchangeRequest is false without urn:pmth:device_code resource", () => {
  assert.equal(
    isDeviceApprovalTokenExchangeRequest({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
      resource: "https://issuer.example/api/v1/oidc",
    }),
    false,
  );
});

test("isDeviceApprovalTokenExchangeRequest is false for wrong subject_token_type", () => {
  assert.equal(
    isDeviceApprovalTokenExchangeRequest({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      resource: "urn:pmth:device_code:ABCD",
    }),
    false,
  );
});

test("handleDeviceApprovalTokenExchange returns subject_token as access_token on success", async () => {
  const auditCalls: unknown[] = [];
  const out = await handleDeviceApprovalTokenExchange(
    {
      clientId: M2M_ID,
      clientSecret: "secret",
      subjectToken: SUBJECT_JWT,
      subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
      resource: "urn:pmth:device_code:ABCD-EFGH",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      audience: [getIssuer()],
    },
    {
      validateClientSecret: async () => true,
      verifyAccessToken: async () => baseJwtPayload(),
      approveDeviceCodeForAccount: async () => ({ ok: true }),
      findOrCreateAppEndUser: async () => ({ id: "eu-1", isNew: false }),
      db: dbMock(rowsForHappyPath()),
      createCorrelationId: () => "cid",
      writeAuditLog: async (entry: { action?: string }) => {
        auditCalls.push(entry);
      },
    },
  );
  assert.equal(out.access_token, SUBJECT_JWT);
  assert.equal(out.token_type, "Bearer");
  assert.equal(out.issued_token_type, "urn:ietf:params:oauth:token-type:access_token");
  assert.ok(auditCalls.some((e) => (e as { action: string }).action === "device_code_approved_token_exchange"));
});

test("handleDeviceApprovalTokenExchange invalid_client when client secret invalid", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "bad",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:ABCD-EFGH",
        },
        {
          validateClientSecret: async () => false,
          db: dbMockSelectForbidden,
        },
    ),
    "invalid_client",
  );
});

test("handleDeviceApprovalTokenExchange invalid_request when subject_token_type is not access_token", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
          resource: "urn:pmth:device_code:ABCD-EFGH",
        },
        {
          validateClientSecret: async () => true,
          db: dbMockSelectForbidden,
        },
      ),
    "invalid_request",
  );
});

test("handleDeviceApprovalTokenExchange invalid_scope without device:approve or users:token", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:ABCD-EFGH",
        },
        {
          validateClientSecret: async () => true,
          db: dbMock([
            [{ ...m2mRowOk, allowedScopes: "openid" }],
          ]),
        },
      ),
    "invalid_scope",
  );
});

test("handleDeviceApprovalTokenExchange invalid_client when no developer app sibling", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:ABCD-EFGH",
        },
        {
          validateClientSecret: async () => true,
          db: dbMock([[m2mRowOk], []]),
        },
      ),
    "invalid_client",
  );
});

test("handleDeviceApprovalTokenExchange invalid_target for bad resource prefix", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "https://example.com/resource",
        },
        {
          validateClientSecret: async () => true,
          db: dbMock([[m2mRowOk]]),
        },
      ),
    "invalid_target",
  );
});

test("handleDeviceApprovalTokenExchange invalid_target when user_code missing from resource", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:",
        },
        {
          validateClientSecret: async () => true,
          db: dbMock([[m2mRowOk]]),
        },
      ),
    "invalid_target",
  );
});

test("handleDeviceApprovalTokenExchange invalid_request when requested_token_type is not access_token", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:ABCD-EFGH",
          requestedTokenType: "urn:ietf:params:oauth:token-type:jwt",
        },
        {
          validateClientSecret: async () => true,
          db: dbMock([[m2mRowOk]]),
        },
      ),
    "invalid_request",
  );
});

test("handleDeviceApprovalTokenExchange invalid_target when audience does not match issuer", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:ABCD-EFGH",
          audience: ["https://unknown-resource-server.example/"],
        },
        {
          validateClientSecret: async () => true,
          db: dbMock([[m2mRowOk]]),
        },
      ),
    "invalid_target",
  );
});

test("handleDeviceApprovalTokenExchange invalid_grant when subject_token client_id mismatches public sibling", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:ABCD-EFGH",
        },
        {
          validateClientSecret: async () => true,
          verifyAccessToken: async () => ({
            ...baseJwtPayload(),
            client_id: "app_other_app",
          }),
          db: dbMock(rowsForHappyPath()),
        },
      ),
    "invalid_grant",
  );
});

test("handleDeviceApprovalTokenExchange invalid_client when third-party device login disabled", async () => {
  const rows = rowsForHappyPath();
  rows[3] = [{ id: "pub-int", deviceThirdPartyInitiateLogin: 0 }];
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:ABCD-EFGH",
        },
        {
          validateClientSecret: async () => true,
          verifyAccessToken: async () => baseJwtPayload(),
          db: dbMock(rows),
        },
      ),
    "invalid_client",
  );
});

test("handleDeviceApprovalTokenExchange invalid_grant when approveDeviceCodeForAccount fails (expired)", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: SUBJECT_JWT,
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:ABCD-EFGH",
        },
        {
          validateClientSecret: async () => true,
          verifyAccessToken: async () => baseJwtPayload(),
          approveDeviceCodeForAccount: async () => ({
            ok: false,
            error: "expired_token",
            description: "The device code has expired",
            status: 400,
          }),
          findOrCreateAppEndUser: async () => ({ id: "eu-1", isNew: false }),
          db: dbMock(rowsForHappyPath()),
        },
      ),
    "expired_token",
  );
});

test("handleDeviceApprovalTokenExchange invalid_grant when subject_token verify fails", async () => {
  await rejectsWithCode(
    () =>
      handleDeviceApprovalTokenExchange(
        {
          clientId: M2M_ID,
          clientSecret: "secret",
          subjectToken: "bad",
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          resource: "urn:pmth:device_code:ABCD-EFGH",
        },
        {
          validateClientSecret: async () => true,
          verifyAccessToken: async () => null,
          db: dbMock(rowsForHappyPath()),
        },
      ),
    "invalid_grant",
  );
});
