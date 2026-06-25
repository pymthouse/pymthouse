import test from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  verifyTurnkeyWebhookSignature,
} from "@turnkey/crypto";
import {
  resetTurnkeyWebhookJwksCacheForTests,
  verifyTurnkeyWebhookRequest,
} from "./verify-webhook";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function buildSignedInputLocal(input: {
  version: string;
  algorithm: string;
  keyId: string;
  timestampMs: string;
  eventId: string;
  body: string;
}): Uint8Array {
  const prefix = new TextEncoder().encode(
    `${input.version}.${input.algorithm}.${input.keyId}.${input.timestampMs}.${input.eventId}.`,
  );
  const bodyBytes = new TextEncoder().encode(input.body);
  const signedInput = new Uint8Array(prefix.length + bodyBytes.length);
  signedInput.set(prefix, 0);
  signedInput.set(bodyBytes, prefix.length);
  return signedInput;
}

function buildSignedWebhookHeaders(input: {
  body: string;
  keyId: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  nowMs?: number;
  eventId?: string;
}): Headers {
  const timestampMs = String(input.nowMs ?? Date.now());
  const eventId = input.eventId ?? "evt_test_1";
  const signedInput = buildSignedInputLocal({
    version: "v1",
    algorithm: "ed25519",
    keyId: input.keyId,
    timestampMs,
    eventId,
    body: input.body,
  });
  const signature = ed25519.sign(signedInput, input.privateKey);
  const headers = new Headers();
  headers.set("x-turnkey-timestamp", timestampMs);
  headers.set("x-turnkey-event-id", eventId);
  headers.set("x-turnkey-signature-key-id", input.keyId);
  headers.set("x-turnkey-signature-algorithm", "ed25519");
  headers.set("x-turnkey-signature-version", "v1");
  headers.set("x-turnkey-signature", hex(signature));
  return headers;
}

test("verifyTurnkeyWebhookRequest accepts valid signature with env keys", async () => {
  resetTurnkeyWebhookJwksCacheForTests();
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const keyId = "test-key";
  const body = JSON.stringify({ eventType: "BALANCE_FINALIZED_UPDATES" });

  const previousKeyId = process.env.TURNKEY_WEBHOOK_KEY_ID;
  const previousPublicKey = process.env.TURNKEY_WEBHOOK_PUBLIC_KEY;
  process.env.TURNKEY_WEBHOOK_KEY_ID = keyId;
  process.env.TURNKEY_WEBHOOK_PUBLIC_KEY = hex(publicKey);

  try {
    const nowMs = 1_700_000_000_000;
    const headers = buildSignedWebhookHeaders({
      body,
      keyId,
      privateKey,
      publicKey,
      nowMs,
    });

    const verified = await verifyTurnkeyWebhookRequest(headers, body, {
      nowMs,
    });
    assert.ok(verified);
    assert.equal(verified?.eventId, "evt_test_1");
  } finally {
    process.env.TURNKEY_WEBHOOK_KEY_ID = previousKeyId;
    process.env.TURNKEY_WEBHOOK_PUBLIC_KEY = previousPublicKey;
    resetTurnkeyWebhookJwksCacheForTests();
  }
});

test("verifyTurnkeyWebhookRequest rejects stale timestamp", async () => {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const keyId = "stale-key";
  const body = "{}";
  const staleMs = 1_000;
  const headers = buildSignedWebhookHeaders({
    body,
    keyId,
    privateKey,
    publicKey,
    nowMs: staleMs,
  });

  const result = verifyTurnkeyWebhookSignature({
    headers,
    body,
    verificationKeys: [{ keyId, publicKey: hex(publicKey), algorithm: "ed25519" }],
    maxTimestampAgeMs: 5 * 60 * 1000,
    nowMs: staleMs + 10 * 60 * 1000,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "stale_timestamp");
  }
});

test("verifyTurnkeyWebhookRequest rejects unknown key id", async () => {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const body = "{}";
  const nowMs = Date.now();
  const headers = buildSignedWebhookHeaders({
    body,
    keyId: "wrong-key",
    privateKey,
    publicKey,
    nowMs,
  });

  const result = verifyTurnkeyWebhookSignature({
    headers,
    body,
    verificationKeys: [
      { keyId: "other-key", publicKey: hex(publicKey), algorithm: "ed25519" },
    ],
    maxTimestampAgeMs: 5 * 60 * 1000,
    nowMs,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "missing_key");
  }
});
