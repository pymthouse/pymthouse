import test from "node:test";
import assert from "node:assert/strict";

import {
  enforceMintAllowanceGate,
  isM2mOwnerSignJobRequest,
  isMintUserSignerTokenRequest,
  mintAllowanceGateDecision,
  MintUserSignerTokenError,
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

test("mintAllowanceGateDecision bypasses when hosted billing is disabled", () => {
  assert.equal(
    mintAllowanceGateDecision(null, false),
    null,
  );
  assert.equal(
    mintAllowanceGateDecision(
      {
        hasAccess: false,
        balanceUsdMicros: "0",
        consumedUsdMicros: "0",
        lifetimeGrantedUsdMicros: "0",
      },
      false,
    ),
    null,
  );
});

test("mintAllowanceGateDecision rejects unconfirmed allowance when hosted billing is enabled", () => {
  assert.deepEqual(mintAllowanceGateDecision(null, true), {
    code: "billing_unavailable",
    message: "Billing allowance could not be confirmed",
  });
});

test("mintAllowanceGateDecision rejects exhausted allowance when hosted billing is enabled", () => {
  assert.deepEqual(
    mintAllowanceGateDecision(
      {
        hasAccess: false,
        balanceUsdMicros: "0",
        consumedUsdMicros: "5000000",
        lifetimeGrantedUsdMicros: "5000000",
      },
      true,
    ),
    {
      code: "trial_credits_exhausted",
      message: "Starter allowance exhausted",
    },
  );
});

test("mintAllowanceGateDecision allows positive Konnect credit balance", () => {
  assert.equal(
    mintAllowanceGateDecision(
      {
        hasAccess: true,
        balanceUsdMicros: "44780000",
        consumedUsdMicros: "5220000",
        lifetimeGrantedUsdMicros: "50000000",
      },
      true,
    ),
    null,
  );
});

test("mintAllowanceGateDecision allows 1-micro and 34-micro remainders", () => {
  assert.equal(
    mintAllowanceGateDecision(
      {
        hasAccess: true,
        balanceUsdMicros: "1",
        consumedUsdMicros: "4999999",
        lifetimeGrantedUsdMicros: "5000000",
      },
      true,
    ),
    null,
  );
  assert.equal(
    mintAllowanceGateDecision(
      {
        hasAccess: false, // stale flag must not override positive micros
        balanceUsdMicros: "34",
        consumedUsdMicros: "4999966",
        lifetimeGrantedUsdMicros: "5000000",
      },
      true,
    ),
    null,
  );
});

test("mintAllowanceGateDecision rejects zero micros even when hasAccess is stale true", () => {
  assert.deepEqual(
    mintAllowanceGateDecision(
      {
        hasAccess: true,
        balanceUsdMicros: "0",
        consumedUsdMicros: "5000000",
        lifetimeGrantedUsdMicros: "5000000",
      },
      true,
    ),
    {
      code: "trial_credits_exhausted",
      message: "Starter allowance exhausted",
    },
  );
});

test("enforceMintAllowanceGate throws billing_unavailable when allowance is null in test env", () => {
  const previousUrl = process.env.OPENMETER_URL;
  const previousLive = process.env.OPENMETER_TEST_LIVE;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_TEST_LIVE = "1";
  try {
    assert.throws(
      () => enforceMintAllowanceGate(null),
      (err: unknown) =>
        err instanceof MintUserSignerTokenError &&
        err.code === "billing_unavailable" &&
        err.status === 402,
    );
  } finally {
    if (previousUrl === undefined) {
      delete process.env.OPENMETER_URL;
    } else {
      process.env.OPENMETER_URL = previousUrl;
    }
    if (previousLive === undefined) {
      delete process.env.OPENMETER_TEST_LIVE;
    } else {
      process.env.OPENMETER_TEST_LIVE = previousLive;
    }
  }
});
