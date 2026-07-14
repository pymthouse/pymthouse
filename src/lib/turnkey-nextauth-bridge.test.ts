import test from "node:test";
import assert from "node:assert/strict";
import {
  firstEvmAddressFromWallets,
  safeCallbackUrl,
} from "./turnkey-nextauth-bridge";

test("safeCallbackUrl keeps same-origin relative paths", () => {
  assert.equal(safeCallbackUrl("/apps"), "/apps");
  assert.equal(safeCallbackUrl("/apps/settings?x=1"), "/apps/settings?x=1");
  assert.equal(safeCallbackUrl("/auth/callback"), "/auth/callback");
});

test("safeCallbackUrl rejects open redirects and empty values", () => {
  assert.equal(safeCallbackUrl(null), "/apps");
  assert.equal(safeCallbackUrl(undefined), "/apps");
  assert.equal(safeCallbackUrl(""), "/apps");
  assert.equal(safeCallbackUrl("//evil.example"), "/apps");
  assert.equal(safeCallbackUrl("https://evil.example"), "/apps");
  assert.equal(safeCallbackUrl("evil.example"), "/apps");
  assert.equal(safeCallbackUrl(null, "/login"), "/login");
});

test("firstEvmAddressFromWallets returns the first 0x account", () => {
  assert.equal(firstEvmAddressFromWallets([]), undefined);
  assert.equal(
    firstEvmAddressFromWallets([{ accounts: [{ address: "solana1" }] }]),
    undefined,
  );
  assert.equal(
    firstEvmAddressFromWallets([
      { accounts: [{ address: "solana1" }, { address: "0xabc" }] },
      { accounts: [{ address: "0xdef" }] },
    ]),
    "0xabc",
  );
});
