import test from "node:test";
import assert from "node:assert/strict";

import { getClientSignerApiUrl } from "@/lib/signer-proxy";
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

test("buildSignerSessionEnvelope sets canonical signer_url only", () => {
  const session = buildSignerSessionEnvelope({
    access_token: "jwt",
    expires_in: 300,
    scope: "sign:job",
    balanceUsdMicros: "0",
    lifetimeGrantedUsdMicros: "1000",
    signer_url: "https://signer.example",
  });
  assert.equal(session.signer_url, "https://signer.example");
  assert.equal(session.access_token, "jwt");
  assert.equal("signerUrl" in session, false);
  assert.equal("token" in session, false);
});

test("getClientSignerApiUrl honors legacy PYMTHOUSE_SIGNER_URL", () => {
  const prior = process.env.PYMTHOUSE_SIGNER_URL;
  process.env.PYMTHOUSE_SIGNER_URL = "https://signer.example/";
  try {
    assert.equal(getClientSignerApiUrl(), "https://signer.example");
  } finally {
    if (prior === undefined) {
      delete process.env.PYMTHOUSE_SIGNER_URL;
    } else {
      process.env.PYMTHOUSE_SIGNER_URL = prior;
    }
  }
});
