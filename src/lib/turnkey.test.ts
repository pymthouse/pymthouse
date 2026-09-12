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
  const id = "b109d006-906c-4f35-84b3-daaec5acfaef";
  assert.equal(isPlaceholderTurnkeyEmail(null, id), true);
  assert.equal(isPlaceholderTurnkeyEmail(`${id}@turnkey.local`, id), true);
  assert.equal(isPlaceholderTurnkeyEmail("qiang@livepeer.org", id), false);
});

test("normalizeTurnkeyEmail lowercases and drops blanks", () => {
  assert.equal(normalizeTurnkeyEmail("  Qiang@Livepeer.org "), "qiang@livepeer.org");
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
      email: "b109d006-906c-4f35-84b3-daaec5acfaef@turnkey.local",
      name: null,
      walletAddress: null,
      turnkeyUserId: "b109d006-906c-4f35-84b3-daaec5acfaef",
    },
    email: "qiang@livepeer.org",
    name: "qiang",
    walletAddress: "0x123",
  });
  assert.deepEqual(updates, {
    email: "qiang@livepeer.org",
    name: "qiang",
    walletAddress: "0x123",
  });
});

test("developerUserUpdates does not overwrite a real email", () => {
  assert.equal(
    developerUserUpdates({
      existing: {
        email: "qiang@livepeer.org",
        name: "qiang",
        walletAddress: "0x123",
        turnkeyUserId: "15d91122-d2b5-453e-961e-3b51b54a2670",
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
