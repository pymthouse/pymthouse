import assert from "node:assert/strict";
import test from "node:test";

test("authorizationFromWebhookPayload is exported from builder-sdk", async () => {
  const mod = await import("@pymthouse/builder-sdk/signer/webhook");
  assert.equal(
    mod.authorizationFromWebhookPayload({
      headers: { Authorization: ["Bearer tok"] },
    }),
    "Bearer tok",
  );
});
