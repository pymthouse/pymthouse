import assert from "node:assert/strict";
import test from "node:test";

import {
  FALLBACK_APPLICATION_FEE_BPS,
  FALLBACK_END_USER_CAP,
  platformDefaultApplicationFeeBps,
  platformDefaultEndUserCap,
} from "@/lib/billing/platform-billing-defaults";

test("defaults match the column defaults when env is unset", () => {
  assert.equal(platformDefaultEndUserCap({}), FALLBACK_END_USER_CAP);
  assert.equal(
    platformDefaultApplicationFeeBps({}),
    FALLBACK_APPLICATION_FEE_BPS,
  );
});

test("env overrides platform policy without a migration", () => {
  assert.equal(
    platformDefaultEndUserCap({ PYMTHOUSE_DEFAULT_END_USER_CAP: "100" }),
    100,
  );
  assert.equal(
    platformDefaultApplicationFeeBps({
      PYMTHOUSE_DEFAULT_APPLICATION_FEE_BPS: "250",
    }),
    250,
  );
});

test("a zero fee is honoured, not treated as unset", () => {
  // 0 bps is a legitimate platform policy; only env absence falls back.
  assert.equal(
    platformDefaultApplicationFeeBps({
      PYMTHOUSE_DEFAULT_APPLICATION_FEE_BPS: "0",
    }),
    0,
  );
});

test("out-of-range values fall back rather than applying", () => {
  // A cap of 0 would block provisioning outright; a negative fee is nonsense.
  assert.equal(
    platformDefaultEndUserCap({ PYMTHOUSE_DEFAULT_END_USER_CAP: "0" }),
    FALLBACK_END_USER_CAP,
  );
  assert.equal(
    platformDefaultEndUserCap({ PYMTHOUSE_DEFAULT_END_USER_CAP: "9999999" }),
    FALLBACK_END_USER_CAP,
  );
  assert.equal(
    platformDefaultApplicationFeeBps({
      PYMTHOUSE_DEFAULT_APPLICATION_FEE_BPS: "-1",
    }),
    FALLBACK_APPLICATION_FEE_BPS,
  );
  assert.equal(
    platformDefaultApplicationFeeBps({
      PYMTHOUSE_DEFAULT_APPLICATION_FEE_BPS: "10001",
    }),
    FALLBACK_APPLICATION_FEE_BPS,
  );
});

test("malformed and blank values fall back", () => {
  assert.equal(
    platformDefaultEndUserCap({ PYMTHOUSE_DEFAULT_END_USER_CAP: "many" }),
    FALLBACK_END_USER_CAP,
  );
  assert.equal(
    platformDefaultEndUserCap({ PYMTHOUSE_DEFAULT_END_USER_CAP: "   " }),
    FALLBACK_END_USER_CAP,
  );
});
