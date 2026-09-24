import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const skipDb = !(
  process.env.DATABASE_URL && process.env.PYMTHOUSE_TEST_DATABASE_URL_UNSET !== "1"
);

test(
  "upsert preserves consumed state for existing rows",
  { skip: skipDb },
  async () => {
    const { PostgresOidcAdapter } = await import("./adapter");
    const adapter = new PostgresOidcAdapter("DeviceCode");
    const id = `device-code-consume-test-${crypto.randomUUID()}`;

    await adapter.upsert(
      id,
      {
        jti: id,
        userCode: "ABCD1234",
        clientId: "test-client",
      },
      600,
    );

    await adapter.consume(id);
    const consumed = await adapter.find(id);
    assert.ok(consumed?.consumed);

    await adapter.upsert(
      id,
      {
        jti: id,
        userCode: "ABCD1234",
        clientId: "test-client",
      },
      600,
    );

    const after = await adapter.find(id);
    assert.ok(after?.consumed, "consumed flag should not be cleared by upsert");
  },
);

test(
  "bindDeviceApprovalIfUnbound refuses denied DeviceCodes",
  { skip: skipDb },
  async () => {
    const { PostgresOidcAdapter } = await import("./adapter");
    const adapter = new PostgresOidcAdapter("DeviceCode");
    const id = `device-code-deny-bind-${crypto.randomUUID()}`;
    const userCode = `DENY${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

    await adapter.upsert(
      id,
      {
        jti: id,
        userCode,
        clientId: "test-client",
        error: "access_denied",
        errorDescription: "The user denied the authorization request",
      },
      600,
    );

    const bound = await adapter.bindDeviceApprovalIfUnbound(
      id,
      {
        jti: id,
        userCode,
        clientId: "test-client",
        accountId: "acct_after_deny",
        grantId: "grant_after_deny",
      },
      600,
    );

    assert.equal(bound, false);
    const after = await adapter.find(id);
    assert.equal(after?.error, "access_denied");
    assert.equal(after?.accountId, undefined);
    assert.equal(after?.grantId, undefined);
  },
);
