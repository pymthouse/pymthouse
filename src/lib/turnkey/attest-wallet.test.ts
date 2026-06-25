import test from "node:test";
import assert from "node:assert/strict";

import {
  MultiAccountWalletError,
  resolveAttestedWalletAddress,
  TurnkeyAttestationError,
} from "./attest-wallet";
import {
  __testClearTurnkeyStubs,
  __testSetTurnkeyEvmAddressesStub,
} from "./server-client";

const ORG = "org-test-1";
const ADDR_A = `0x${"a1".repeat(20)}`;
const ADDR_B = `0x${"b2".repeat(20)}`;

test.afterEach(() => {
  __testClearTurnkeyStubs();
});

test("resolveAttestedWalletAddress picks sole attested address", async () => {
  __testSetTurnkeyEvmAddressesStub({ [ORG]: [ADDR_A] });
  const result = await resolveAttestedWalletAddress({ organizationId: ORG });
  assert.equal(result.walletAddress, ADDR_A);
});

test("resolveAttestedWalletAddress uses client hint when multiple accounts", async () => {
  __testSetTurnkeyEvmAddressesStub({ [ORG]: [ADDR_A, ADDR_B] });
  const result = await resolveAttestedWalletAddress({
    organizationId: ORG,
    clientHint: ADDR_B,
  });
  assert.equal(result.walletAddress, ADDR_B);
});

test("resolveAttestedWalletAddress throws MultiAccountWalletError without hint", async () => {
  __testSetTurnkeyEvmAddressesStub({ [ORG]: [ADDR_A, ADDR_B] });
  await assert.rejects(
    () => resolveAttestedWalletAddress({ organizationId: ORG }),
    MultiAccountWalletError,
  );
});

test("resolveAttestedWalletAddress requires attestation when Turnkey configured", async () => {
  __testSetTurnkeyEvmAddressesStub({}, true);
  await assert.rejects(
    () =>
      resolveAttestedWalletAddress({
        organizationId: ORG,
        requireAttestation: true,
      }),
    TurnkeyAttestationError,
  );
});

test("resolveAttestedWalletAddress falls back to client hint when Turnkey unconfigured", async () => {
  __testSetTurnkeyEvmAddressesStub({}, false);
  const result = await resolveAttestedWalletAddress({
    organizationId: ORG,
    clientHint: ADDR_A,
  });
  assert.equal(result.walletAddress, ADDR_A);
});
