import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { PostgresOidcAdapter } from "./adapter";
import {
  approveDeviceCodeForAccount,
  isDeviceCodeBound,
  isDeviceCodeDenied,
  isDeviceCodeSettled,
} from "./device-approval";

const skipDb = !(
  process.env.DATABASE_URL && process.env.PYMTHOUSE_TEST_DATABASE_URL_UNSET !== "1"
);

test("isDeviceCodeBound is true when accountId is set", () => {
  assert.equal(isDeviceCodeBound({ accountId: "acct_1" }), true);
});

test("isDeviceCodeBound is true when grantId is set", () => {
  assert.equal(isDeviceCodeBound({ grantId: "g_1" }), true);
});

test("isDeviceCodeBound is false when unbound", () => {
  assert.equal(isDeviceCodeBound({}), false);
  assert.equal(isDeviceCodeBound({ accountId: "" }), false);
  assert.equal(isDeviceCodeBound({ grantId: "" }), false);
});

test("isDeviceCodeDenied is true when error is set", () => {
  assert.equal(isDeviceCodeDenied({ error: "access_denied" }), true);
});

test("isDeviceCodeDenied is false without a non-empty error", () => {
  assert.equal(isDeviceCodeDenied({}), false);
  assert.equal(isDeviceCodeDenied({ error: "" }), false);
  assert.equal(isDeviceCodeDenied({ error: null }), false);
  assert.equal(isDeviceCodeDenied({ accountId: "acct_1" }), false);
});

test("isDeviceCodeSettled treats deny and approve as terminal", () => {
  assert.equal(isDeviceCodeSettled({ error: "access_denied" }), true);
  assert.equal(isDeviceCodeSettled({ accountId: "acct_1" }), true);
  assert.equal(isDeviceCodeSettled({ grantId: "g_1" }), true);
  assert.equal(isDeviceCodeSettled({}), false);
});

test("denied DeviceCodes stay unbound but settled (cannot re-approve)", () => {
  const denied = { error: "access_denied", errorDescription: "denied" };
  assert.equal(isDeviceCodeBound(denied), false);
  assert.equal(isDeviceCodeDenied(denied), true);
  assert.equal(isDeviceCodeSettled(denied), true);
});

async function insertPendingDeviceCode(
  adapter: PostgresOidcAdapter,
  id: string,
  userCode: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + 600;
  await adapter.upsert(
    id,
    {
      jti: id,
      userCode,
      clientId: "test-client",
      exp,
      ...extra,
    },
    600,
  );
}

test(
  "approveDeviceCodeForAccount rejects a DeviceCode that is already denied",
  { skip: skipDb },
  async () => {
    const adapter = new PostgresOidcAdapter("DeviceCode");
    const id = `device-code-approve-denied-${crypto.randomUUID()}`;
    const userCode = `DNY${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    try {
      await insertPendingDeviceCode(adapter, id, userCode, {
        error: "access_denied",
        errorDescription: "The user denied the authorization request",
      });

      const result = await approveDeviceCodeForAccount(
        userCode,
        "test-client",
        "acct_after_deny",
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, "access_denied");
        assert.equal(result.status, 400);
      }
      const after = await adapter.find(id);
      assert.equal(after?.accountId, undefined);
      assert.equal(after?.error, "access_denied");
    } finally {
      await adapter.destroy(id);
    }
  },
);

test(
  "approveDeviceCodeForAccount rejects when denial lands before bind",
  { skip: skipDb },
  async () => {
    const adapter = new PostgresOidcAdapter("DeviceCode");
    const id = `device-code-approve-race-deny-${crypto.randomUUID()}`;
    const userCode = `RCE${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const originalFind = PostgresOidcAdapter.prototype.find;
    PostgresOidcAdapter.prototype.find = async function findDenied(
      findId: string,
    ) {
      if (findId === id) {
        return {
          jti: id,
          userCode,
          clientId: "test-client",
          error: "access_denied",
        };
      }
      return originalFind.call(this, findId);
    };
    try {
      await insertPendingDeviceCode(adapter, id, userCode);

      const result = await approveDeviceCodeForAccount(
        userCode,
        "test-client",
        "acct_race",
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, "access_denied");
        assert.equal(result.status, 400);
      }
    } finally {
      PostgresOidcAdapter.prototype.find = originalFind;
      await adapter.destroy(id);
    }
  },
);

test(
  "approveDeviceCodeForAccount rejects when denial lands during bind",
  { skip: skipDb },
  async () => {
    const adapter = new PostgresOidcAdapter("DeviceCode");
    const id = `device-code-approve-bind-deny-${crypto.randomUUID()}`;
    const userCode = `BDN${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const originalBind = PostgresOidcAdapter.prototype.bindDeviceApprovalIfUnbound;
    PostgresOidcAdapter.prototype.bindDeviceApprovalIfUnbound =
      async function bindAfterDeny(bindId, payload, expiresIn) {
        if (bindId === id) {
          const current = await this.find(bindId);
          await this.upsert(
            bindId,
            {
              ...(current ?? {}),
              error: "access_denied",
              errorDescription: "The user denied the authorization request",
            },
            expiresIn,
          );
        }
        return originalBind.call(this, bindId, payload, expiresIn);
      };
    try {
      await insertPendingDeviceCode(adapter, id, userCode);

      const result = await approveDeviceCodeForAccount(
        userCode,
        "test-client",
        "acct_during_bind",
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, "access_denied");
        assert.equal(result.status, 400);
      }
      const after = await adapter.find(id);
      assert.equal(after?.error, "access_denied");
      assert.equal(after?.accountId, undefined);
      assert.equal(after?.grantId, undefined);
    } finally {
      PostgresOidcAdapter.prototype.bindDeviceApprovalIfUnbound = originalBind;
      await adapter.destroy(id);
    }
  },
);

test(
  "approveDeviceCodeForAccount is idempotent when bind loses to an existing binding",
  { skip: skipDb },
  async () => {
    const adapter = new PostgresOidcAdapter("DeviceCode");
    const id = `device-code-approve-bind-race-${crypto.randomUUID()}`;
    const userCode = `BWN${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const originalBind = PostgresOidcAdapter.prototype.bindDeviceApprovalIfUnbound;
    PostgresOidcAdapter.prototype.bindDeviceApprovalIfUnbound =
      async function bindAfterWinner(bindId, payload, expiresIn) {
        if (bindId === id) {
          const current = await this.find(bindId);
          await this.upsert(
            bindId,
            {
              ...(current ?? {}),
              accountId: "acct_winner",
              grantId: "grant_winner",
            },
            expiresIn,
          );
        }
        return originalBind.call(this, bindId, payload, expiresIn);
      };
    try {
      await insertPendingDeviceCode(adapter, id, userCode);

      const result = await approveDeviceCodeForAccount(
        userCode,
        "test-client",
        "acct_loser",
      );

      assert.deepEqual(result, { ok: true });
      const after = await adapter.find(id);
      assert.equal(after?.accountId, "acct_winner");
      assert.equal(after?.grantId, "grant_winner");
      assert.equal(after?.error, undefined);
    } finally {
      PostgresOidcAdapter.prototype.bindDeviceApprovalIfUnbound = originalBind;
      await adapter.destroy(id);
    }
  },
);

test(
  "approveDeviceCodeForAccount is idempotent when the DeviceCode is already bound",
  { skip: skipDb },
  async () => {
    const adapter = new PostgresOidcAdapter("DeviceCode");
    const id = `device-code-approve-bound-${crypto.randomUUID()}`;
    const userCode = `BND${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const originalFind = PostgresOidcAdapter.prototype.find;
    PostgresOidcAdapter.prototype.find = async function findBound(
      findId: string,
    ) {
      if (findId === id) {
        return {
          jti: id,
          userCode,
          clientId: "test-client",
          accountId: "acct_existing",
          grantId: "grant_existing",
        };
      }
      return originalFind.call(this, findId);
    };
    try {
      await insertPendingDeviceCode(adapter, id, userCode);

      const result = await approveDeviceCodeForAccount(
        userCode,
        "test-client",
        "acct_new",
      );

      assert.deepEqual(result, { ok: true });
      PostgresOidcAdapter.prototype.find = originalFind;
      const after = await adapter.find(id);
      assert.equal(after?.accountId, undefined);
      assert.equal(after?.grantId, undefined);
    } finally {
      PostgresOidcAdapter.prototype.find = originalFind;
      await adapter.destroy(id);
    }
  },
);
