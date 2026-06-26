import test from "node:test";
import assert from "node:assert/strict";

import {
  isM2mOwnerSignJobRequest,
  isMintUserSignerTokenRequest,
} from "./mint-user-signer-token";

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

test("isMintUserSignerTokenRequest matches sign:mint_user_token client_credentials", () => {
  assert.equal(
    isMintUserSignerTokenRequest(
      params({
        grant_type: "client_credentials",
        scope: "sign:mint_user_token",
      }),
    ),
    true,
  );
});

test("isM2mOwnerSignJobRequest matches sign:job without external_user_id", () => {
  assert.equal(
    isM2mOwnerSignJobRequest(
      params({
        grant_type: "client_credentials",
        scope: "sign:job",
      }),
    ),
    true,
  );
});

test("isM2mOwnerSignJobRequest rejects when external_user_id is present", () => {
  assert.equal(
    isM2mOwnerSignJobRequest(
      params({
        grant_type: "client_credentials",
        scope: "sign:job",
        external_user_id: "user-123",
      }),
    ),
    false,
  );
});

test("isM2mOwnerSignJobRequest rejects sign:mint_user_token path", () => {
  assert.equal(
    isM2mOwnerSignJobRequest(
      params({
        grant_type: "client_credentials",
        scope: "sign:mint_user_token sign:job",
      }),
    ),
    false,
  );
  assert.equal(
    isMintUserSignerTokenRequest(
      params({
        grant_type: "client_credentials",
        scope: "sign:mint_user_token sign:job",
      }),
    ),
    true,
  );
});

test("isM2mOwnerSignJobRequest rejects admin-only scopes", () => {
  assert.equal(
    isM2mOwnerSignJobRequest(
      params({
        grant_type: "client_credentials",
        scope: "users:write",
      }),
    ),
    false,
  );
});
