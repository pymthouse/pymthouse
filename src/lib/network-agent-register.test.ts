import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";
import { withTemporaryPlatformDefault } from "@/test-utils/platform-default-lock";
import { db } from "@/db/index";
import { apiKeys, appUsers, users } from "@/db/schema";
import {
  NetworkAgentRegisterError,
  agentExternalUserId,
  createRegisterChallenge,
  expireRegisterChallengeForTests,
  normalizeEd25519PublicKey,
  publicKeyFingerprint,
  registerNetworkAgent,
  resetNetworkAgentRegisterStateForTests,
  verifyEd25519Challenge,
} from "@/lib/network-agent-register";

function generateAgentKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const rawPk = Buffer.from(jwk.x, "base64url");
  return {
    publicKeyHex: rawPk.toString("hex"),
    privateKey,
    rawPk,
  };
}

function signNonce(
  privateKey: ReturnType<typeof generateAgentKeyPair>["privateKey"],
  nonce: string,
) {
  return sign(null, Buffer.from(nonce, "utf8"), privateKey).toString("hex");
}

async function seedTemporaryDefault(
  t: { after: (fn: () => Promise<void>) => void },
): Promise<SeededDeveloperApp> {
  const app = await seedDeveloperAppWithClient({
    name: `Default ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });
  return app;
}

async function cleanupAgent(externalUserId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM api_keys
    WHERE app_user_id IN (
      SELECT id FROM app_users WHERE external_user_id = ${externalUserId}
    )
  `);
  await db.delete(appUsers).where(eq(appUsers.externalUserId, externalUserId));
}

test("fingerprint is stable for the same public key", () => {
  const { publicKeyHex, rawPk } = generateAgentKeyPair();
  const a = publicKeyFingerprint(publicKeyHex);
  const b = publicKeyFingerprint(rawPk);
  const c = publicKeyFingerprint(`0x${publicKeyHex}`);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a.length, 32);
  assert.equal(agentExternalUserId(publicKeyHex), `agent:${a}`);
});

test("normalizeEd25519PublicKey rejects bad lengths", () => {
  assert.throws(
    () => normalizeEd25519PublicKey("aa".repeat(16)),
    (err: unknown) =>
      err instanceof NetworkAgentRegisterError && err.code === "invalid_public_key",
  );
});

test("verifyEd25519Challenge accepts good sig and rejects bad/expired", () => {
  resetNetworkAgentRegisterStateForTests();
  const { publicKeyHex, privateKey } = generateAgentKeyPair();
  const challenge = createRegisterChallenge({
    publicKey: publicKeyHex,
    clientIp: "127.0.0.1",
  });

  const goodSig = signNonce(privateKey, challenge.nonce);
  const verified = verifyEd25519Challenge({
    publicKey: publicKeyHex,
    challengeId: challenge.challengeId,
    signature: goodSig,
  });
  assert.equal(verified.externalUserId, agentExternalUserId(publicKeyHex));

  // Challenge is one-time — reuse fails.
  assert.throws(
    () =>
      verifyEd25519Challenge({
        publicKey: publicKeyHex,
        challengeId: challenge.challengeId,
        signature: goodSig,
      }),
    (err: unknown) =>
      err instanceof NetworkAgentRegisterError && err.code === "invalid_challenge",
  );

  const challenge2 = createRegisterChallenge({
    publicKey: publicKeyHex,
    clientIp: "127.0.0.1",
  });
  assert.throws(
    () =>
      verifyEd25519Challenge({
        publicKey: publicKeyHex,
        challengeId: challenge2.challengeId,
        signature: "ab".repeat(64),
      }),
    (err: unknown) =>
      err instanceof NetworkAgentRegisterError && err.code === "invalid_signature",
  );
});

test("expired challenge is rejected", () => {
  resetNetworkAgentRegisterStateForTests();
  const { publicKeyHex, privateKey } = generateAgentKeyPair();
  const challenge = createRegisterChallenge({
    publicKey: publicKeyHex,
    clientIp: "10.0.0.2",
  });
  const sig = signNonce(privateKey, challenge.nonce);
  expireRegisterChallengeForTests(challenge.challengeId);
  assert.throws(
    () =>
      verifyEd25519Challenge({
        publicKey: publicKeyHex,
        challengeId: challenge.challengeId,
        signature: sig,
      }),
    (err: unknown) =>
      err instanceof NetworkAgentRegisterError &&
      err.code === "invalid_challenge" &&
      err.message.includes("expired"),
  );
});

test("registerNetworkAgent creates app_users + key, no users row; duplicate 409", async (t) => {
  resetNetworkAgentRegisterStateForTests();
  const app = await seedTemporaryDefault(t);

  await withTemporaryPlatformDefault(app.clientId, async () => {
    const { publicKeyHex, privateKey } = generateAgentKeyPair();
    const externalUserId = agentExternalUserId(publicKeyHex);
    t.after(async () => {
      await cleanupAgent(externalUserId);
    });

    const challenge = createRegisterChallenge({
      publicKey: publicKeyHex,
      clientIp: "10.0.0.3",
    });
    const result = await registerNetworkAgent({
      publicKey: publicKeyHex,
      challengeId: challenge.challengeId,
      signature: signNonce(privateKey, challenge.nonce),
      label: "test-agent",
      clientIp: "10.0.0.3",
    });

    assert.equal(result.clientId, app.clientId);
    assert.equal(result.externalUserId, externalUserId);
    assert.ok(result.apiKey.startsWith(`${app.clientId}_`));

    const membership = await db
      .select()
      .from(appUsers)
      .where(eq(appUsers.externalUserId, externalUserId));
    assert.equal(membership.length, 1);
    assert.equal(membership[0]?.clientId, app.clientId);

    const keyRows = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.appUserId, membership[0]!.id));
    assert.equal(keyRows.length, 1);

    const platformUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, externalUserId));
    assert.equal(platformUsers.length, 0);

    const challenge2 = createRegisterChallenge({
      publicKey: publicKeyHex,
      clientIp: "10.0.0.3",
    });
    await assert.rejects(
      () =>
        registerNetworkAgent({
          publicKey: publicKeyHex,
          challengeId: challenge2.challengeId,
          signature: signNonce(privateKey, challenge2.nonce),
          clientIp: "10.0.0.3",
        }),
      (err: unknown) =>
        err instanceof NetworkAgentRegisterError &&
        err.code === "conflict" &&
        err.status === 409,
    );
  });
});
