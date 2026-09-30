import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  completeWalletLogin,
  maskEmail,
  WalletLoginError,
  type WalletLoginDeps,
  type WalletLoginInput,
} from "./turnkey-wallet-login";

const PUBLIC_KEY = "02" + "11".repeat(32);

function deps(overrides: Partial<WalletLoginDeps> = {}): WalletLoginDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  const base: WalletLoginDeps = {
    parentOrganizationId: () => "parent",
    getClient: () => ({
      getSubOrgIds: async () => {
        calls.push("getSubOrgIds");
        return { organizationIds: [] };
      },
      getVerifiedSubOrgIds: async () => {
        calls.push("getVerifiedSubOrgIds");
        return { organizationIds: [] };
      },
      getUsers: async () => ({
        users: [{ userId: "tk-user", oauthProviders: [] }],
      }),
      createSubOrganization: async () => {
        calls.push("createSubOrganization");
        return { subOrganizationId: "sub-new" };
      },
      oauthLogin: async () => {
        calls.push("oauthLogin");
        return { session: "header.e30.sig" };
      },
      otpLogin: async () => {
        calls.push("otpLogin");
        return { session: "header.e30.sig" };
      },
    }),
    mintWalletToken: async () => {
      calls.push("mintWallet");
      return "wallet-token";
    },
    mintGithubToken: async () => "github-token",
    findByEmail: async () => [],
    findByTurnkeyUserId: async () => null,
    insertUser: async () => {
      calls.push("insertUser");
    },
    updateUser: async () => {
      calls.push("updateUser");
    },
    nowIso: () => "2026-09-30T00:00:00.000Z",
    log: () => undefined,
  };
  return { ...base, ...overrides, calls };
}

function input(partial: Partial<WalletLoginInput> = {}): WalletLoginInput {
  return {
    verifiedEmail: "dev@example.com",
    publicKey: PUBLIC_KEY,
    nonce: createHash("sha256").update(PUBLIC_KEY, "utf8").digest("hex"),
    method: "google",
    googleIdToken: "google-token",
    ...partial,
  };
}

test("maskEmail keeps the first character and domain", () => {
  assert.equal(maskEmail("qiang@livepeer.org"), "q***@livepeer.org");
});

test("refuses a missing email before creating a wallet", async () => {
  await assert.rejects(
    () => completeWalletLogin(input({ verifiedEmail: "   " }), deps()),
    (err: unknown) => err instanceof WalletLoginError && err.code === "blocked_no_email",
  );
});

test("new google signup creates one sub-org with the wallet issuer", async () => {
  const client = deps();
  const result = await completeWalletLogin(input(), client);
  assert.equal(result.kind, "session");
  if (result.kind !== "session") return;
  assert.equal(result.outcome, "new_signup");
  assert.equal(result.subOrganizationId, "sub-new");
  assert.ok(client.calls.includes("insertUser"));
  assert.ok(client.calls.includes("createSubOrganization"));
  assert.ok(!client.calls.includes("otpLogin"));
});

test("google against an email-only sub-org asks for a one-time code", async () => {
  const client = deps({
    findByEmail: async () => [
      {
        id: "user-1",
        email: "dev@example.com",
        name: null,
        turnkeyUserId: "tk-1",
        turnkeySubOrgId: "sub-email",
        walletLinkedAt: null,
      },
    ],
  });
  const result = await completeWalletLogin(input(), client);
  assert.deepEqual(result, {
    kind: "confirm-email",
    email: "dev@example.com",
    subOrganizationId: "sub-email",
  });
  assert.ok(!client.calls.includes("createSubOrganization"));
});

test("a lookalike Google issuer does not open the Google wallet", async () => {
  let oauthCalls = 0;
  const client = deps({
    findByEmail: async () => [
      {
        id: "user-1",
        email: "dev@example.com",
        name: null,
        turnkeyUserId: "tk-1",
        turnkeySubOrgId: "sub-email",
        walletLinkedAt: null,
      },
    ],
    getClient: () => ({
      getSubOrgIds: async () => ({ organizationIds: [] }),
      getVerifiedSubOrgIds: async () => ({ organizationIds: [] }),
      getUsers: async () => ({
        users: [
          {
            userId: "tk-1",
            oauthProviders: [
              { providerName: "custom", issuer: "https://evil.example/accounts.google.com" },
            ],
          },
        ],
      }),
      createSubOrganization: async () => ({ subOrganizationId: "unused" }),
      oauthLogin: async () => {
        oauthCalls += 1;
        return { session: "sess" };
      },
      otpLogin: async () => ({ session: "no" }),
    }),
  });
  const result = await completeWalletLogin(input(), client);
  assert.equal(result.kind, "confirm-email");
  assert.equal(oauthCalls, 0);
});

test("direct login when the wallet issuer is already on the sub-org", async () => {
  const client = deps({
    findByEmail: async () => [
      {
        id: "user-1",
        email: "dev@example.com",
        name: null,
        turnkeyUserId: "tk-1",
        turnkeySubOrgId: "sub-1",
        walletLinkedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    getClient: () => ({
      getSubOrgIds: async () => ({ organizationIds: ["sub-1"] }),
      getVerifiedSubOrgIds: async () => ({ organizationIds: [] }),
      getUsers: async () => ({ users: [] }),
      createSubOrganization: async () => ({ subOrganizationId: "unused" }),
      oauthLogin: async (body) => {
        assert.equal(body.organizationId, "sub-1");
        assert.equal(body.publicKey, PUBLIC_KEY);
        return { session: "sess" };
      },
      otpLogin: async () => ({ session: "no" }),
    }),
  });
  const result = await completeWalletLogin(input(), client);
  assert.equal(result.kind, "session");
  if (result.kind !== "session") return;
  assert.equal(result.outcome, "migrated_direct");
});
