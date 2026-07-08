import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "./route";

test("POST /webhooks/turnkey-balance rejects invalid signature", async () => {
  const request = new Request("http://localhost/webhooks/turnkey-balance", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-turnkey-signature": "00".repeat(64),
      "x-turnkey-signature-key-id": "missing-key",
      "x-turnkey-signature-algorithm": "ed25519",
      "x-turnkey-signature-version": "v1",
      "x-turnkey-timestamp": String(Date.now()),
      "x-turnkey-event-id": "evt-test",
    },
    body: JSON.stringify({ type: "balances:finalized" }),
  });

  const response = await POST(request);
  assert.equal(response.status, 401);
  const body = (await response.json()) as { status: string; reason: string };
  assert.equal(body.status, "error");
  assert.ok(body.reason);
});

test("POST /webhooks/turnkey-balance ignores invalid JSON after signature failure path", async () => {
  const request = new Request("http://localhost/webhooks/turnkey-balance", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: "not-json",
  });

  const response = await POST(request);
  assert.equal(response.status, 401);
});
