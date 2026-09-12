import test from "node:test";
import assert from "node:assert/strict";
import {
  developerUserUpdates,
  firstEvmAddressFromTurnkeyWallets,
  isPlaceholderTurnkeyEmail,
  normalizeTurnkeyEmail,
  resolveTurnkeyDeveloperIdentity,
  verifyTurnkeySessionJwt,
} from "./turnkey";

test("verifyTurnkeySessionJwt rejects malformed token", async () => {
  const out = await verifyTurnkeySessionJwt("not-a-jwt");
  assert.equal(out, null);
});

test("verifyTurnkeySessionJwt rejects empty", async () => {
  const out = await verifyTurnkeySessionJwt("   ");
  assert.equal(out, null);
});

test("isPlaceholderTurnkeyEmail treats missing and @turnkey.local as placeholders", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(isPlaceholderTurnkeyEmail(null, id), true);
  assert.equal(isPlaceholderTurnkeyEmail(`${id}@turnkey.local`, id), true);
  assert.equal(isPlaceholderTurnkeyEmail("dev@example.com", id), false);
});

test("normalizeTurnkeyEmail lowercases and drops blanks", () => {
  assert.equal(normalizeTurnkeyEmail("  Dev@Example.com "), "dev@example.com");
  assert.equal(normalizeTurnkeyEmail("  "), undefined);
});

test("firstEvmAddressFromTurnkeyWallets returns the first 0x account", () => {
  assert.equal(firstEvmAddressFromTurnkeyWallets([]), undefined);
  assert.equal(
    firstEvmAddressFromTurnkeyWallets([
      { accounts: [{ address: "solana1" }, { address: "0xabc" }] },
    ]),
    "0xabc",
  );
});

test("developerUserUpdates fills placeholder email and missing name/wallet", () => {
  const updates = developerUserUpdates({
    existing: {
      email: "00000000-0000-4000-8000-000000000001@turnkey.local",
      name: null,
      walletAddress: null,
      turnkeyUserId: "00000000-0000-4000-8000-000000000001",
    },
    email: "dev@example.com",
    name: "dev",
    walletAddress: "0x123",
  });
  assert.deepEqual(updates, {
    email: "dev@example.com",
    name: "dev",
    walletAddress: "0x123",
  });
});

test("developerUserUpdates does not overwrite a real email", () => {
  assert.equal(
    developerUserUpdates({
      existing: {
        email: "dev@example.com",
        name: "dev",
        walletAddress: "0x123",
        turnkeyUserId: "00000000-0000-4000-8000-000000000002",
      },
      email: "other@example.com",
      name: "other",
    }),
    null,
  );
});

test("resolveTurnkeyDeveloperIdentity reads the matching sub-org user", async () => {
  const identity = await resolveTurnkeyDeveloperIdentity(
    {
      userId: "user-1",
      organizationId: "sub-org-1",
      expirySeconds: 1,
      sessionType: "SESSION_TYPE_READ_WRITE",
    },
    {
      getClient: () => ({
        getUsers: async ({ organizationId }) => {
          assert.equal(organizationId, "sub-org-1");
          return {
            users: [
              { userId: "other", userEmail: "nope@example.com" },
              {
                userId: "user-1",
                userEmail: "You@Example.com",
                userName: "You",
              },
            ],
          };
        },
        getWallets: async () => ({
          wallets: [{ accounts: [{ address: "0xabc" }] }],
        }),
      }),
    },
  );
  assert.deepEqual(identity, {
    email: "you@example.com",
    name: "You",
    walletAddress: "0xabc",
  });
});
