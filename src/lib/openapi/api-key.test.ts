import test from "node:test";
import assert from "node:assert/strict";

import { parseAppApiKeyBearer } from "@/lib/openapi/api-key";
import { ApiKeyCredentialError } from "@/lib/openapi/api-key";
import { buildSignerSessionEnvelope } from "@/lib/openapi/signer-session";

test("parseAppApiKeyBearer rejects pmth_cs_ client secrets with invalid_request", () => {
  assert.throws(
    () => parseAppApiKeyBearer("pmth_cs_abc123"),
    (err: unknown) => {
      assert.ok(err instanceof ApiKeyCredentialError);
      assert.equal(err.code, "invalid_request");
      assert.equal(err.status, 400);
      assert.match(err.message, /client secret/i);
      return true;
    },
  );
});

test("parseAppApiKeyBearer accepts pmth_ API keys", () => {
  const key = "pmth_" + "a".repeat(64);
  assert.equal(parseAppApiKeyBearer(key), key);
});

test("buildSignerSessionEnvelope sets canonical signer_url and legacy signerUrl", () => {
  const session = buildSignerSessionEnvelope({
    access_token: "jwt",
    expires_in: 300,
    scope: "sign:job",
    balanceUsdMicros: "0",
    lifetimeGrantedUsdMicros: "1000",
    signer_url: "https://signer.example",
  });
  assert.equal(session.signer_url, "https://signer.example");
  assert.equal(session.signerUrl, "https://signer.example");
  assert.equal(session.access_token, "jwt");
  assert.equal(session.token?.access_token, "jwt");
});
