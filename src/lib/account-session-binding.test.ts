import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyAccountSessionBinding } from "@/lib/account-session-binding";
import type { TurnkeySessionClaims } from "@/lib/turnkey";

const claims: TurnkeySessionClaims = {
  userId: "turnkey-user-old-sub-org",
  organizationId: "turnkey-old-sub-org",
  expirySeconds: Math.floor(Date.now() / 1000) + 300,
  sessionType: "READ_WRITE",
};

describe("verifyAccountSessionBinding", () => {
  it("accepts the exact Turnkey user mapped to the NextAuth user", async () => {
    const result = await verifyAccountSessionBinding(
      {
        userId: "pymthouse-old-account",
        turnkeySessionJwt: "signed.session.jwt",
      },
      {
        verifySessionJwt: async () => claims,
        loadTurnkeyUserId: async () => "turnkey-user-old-sub-org",
      },
    );
    assert.deepEqual(result, { ok: true });
  });

  it("rejects a stale Turnkey session from another browser user", async () => {
    const result = await verifyAccountSessionBinding(
      {
        userId: "pymthouse-current-account",
        turnkeySessionJwt: "signed.session.jwt",
      },
      {
        verifySessionJwt: async () => claims,
        loadTurnkeyUserId: async () => "turnkey-user-current-account",
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
  });

  it("rejects invalid sessions and users without a Turnkey mapping", async () => {
    const invalidSession = await verifyAccountSessionBinding(
      {
        userId: "pymthouse-account",
        turnkeySessionJwt: "invalid.session.jwt",
      },
      {
        verifySessionJwt: async () => null,
        loadTurnkeyUserId: async () => "turnkey-user",
      },
    );
    assert.equal(invalidSession.ok, false);
    if (!invalidSession.ok) assert.equal(invalidSession.status, 401);

    const unmapped = await verifyAccountSessionBinding(
      {
        userId: "pymthouse-account",
        turnkeySessionJwt: "signed.session.jwt",
      },
      {
        verifySessionJwt: async () => claims,
        loadTurnkeyUserId: async () => null,
      },
    );
    assert.equal(unmapped.ok, false);
    if (!unmapped.ok) assert.equal(unmapped.status, 403);
  });
});
