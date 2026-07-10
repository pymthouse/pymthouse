import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { POST } from "./route";

const TURNKEY_JWKS_URL =
  "https://api.turnkey.com/public/v1/discovery/webhooks/jwks";

const { publicKey } = generateKeyPairSync("ed25519");
const publicJwk = publicKey.export({ format: "jwk" }) as { x: string };
const JWKS_BODY = JSON.stringify({
  keys: [
    {
      kid: "test-key",
      kty: "OKP",
      crv: "Ed25519",
      x: publicJwk.x,
    },
  ],
});

let fetchMock: ReturnType<typeof mock.fn>;

test.before(() => {
  const originalFetch = globalThis.fetch.bind(globalThis);
  fetchMock = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith(TURNKEY_JWKS_URL)) {
      return new Response(JWKS_BODY, {
        status: 200,
        headers: { "cache-control": "max-age=300" },
      });
    }
    return originalFetch(input, init);
  });
  mock.method(globalThis, "fetch", fetchMock);
});

test.after(() => {
  fetchMock.mock.restore();
});

test("POST /webhooks/turnkey-balance rejects invalid signature", async () => {
  const request = new Request("http://localhost/webhooks/turnkey-balance", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-turnkey-signature": "ab".repeat(64),
      "x-turnkey-signature-key-id": "test-key",
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

test("POST /webhooks/turnkey-balance rejects missing signature headers", async () => {
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
