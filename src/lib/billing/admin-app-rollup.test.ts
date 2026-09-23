import assert from "node:assert/strict";
import test from "node:test";

import {
  appMatchesStatusFilter,
  appNeedsAttention,
  appSharesOwnerCostRail,
  blockedRollupM2mUserCount,
  decideAppUserCreditGrant,
  ownerRollupSpendableUsdMicros,
  parseAppListQuery,
} from "@/lib/billing/admin-app-rollup";

test("parseAppListQuery reads q, paging, status, and billingMode", () => {
  const parsed = parseAppListQuery(
    new URLSearchParams(
      "q=Dashboard&page=2&pageSize=50&status=attention&billingMode=owner_rollup",
    ),
  );
  assert.equal(parsed.q, "Dashboard");
  assert.equal(parsed.page, 2);
  assert.equal(parsed.pageSize, 50);
  assert.equal(parsed.status, "attention");
  assert.equal(parsed.billingMode, "owner_rollup");
});

test("parseAppListQuery ignores unknown filters", () => {
  const parsed = parseAppListQuery(
    new URLSearchParams("status=nope&billingMode=foo"),
  );
  assert.equal(parsed.status, "all");
  assert.equal(parsed.billingMode, "all");
});

test("owner_rollup non-default apps share the owner cost rail", () => {
  assert.equal(
    appSharesOwnerCostRail({
      billingMode: "owner_rollup",
      isPlatformDefault: false,
    }),
    true,
  );
  assert.equal(
    appSharesOwnerCostRail({
      billingMode: "merchant",
      isPlatformDefault: false,
    }),
    false,
  );
  assert.equal(
    appSharesOwnerCostRail({
      billingMode: "owner_rollup",
      isPlatformDefault: true,
    }),
    false,
  );
});

test("blocked M2M count is active users when owner-rollup owner is blocked", () => {
  assert.equal(
    blockedRollupM2mUserCount({
      sharesOwnerCostRail: true,
      ownerUsageStatus: "blocked",
      activeM2mUserCount: 12,
    }),
    12,
  );
  assert.equal(
    blockedRollupM2mUserCount({
      sharesOwnerCostRail: true,
      ownerUsageStatus: "ok",
      activeM2mUserCount: 12,
    }),
    0,
  );
  assert.equal(
    blockedRollupM2mUserCount({
      sharesOwnerCostRail: false,
      ownerUsageStatus: "blocked",
      activeM2mUserCount: 12,
    }),
    0,
  );
});

test("attention is owner-rollup blocked or overage", () => {
  assert.equal(
    appNeedsAttention({
      sharesOwnerCostRail: true,
      ownerUsageStatus: "blocked",
    }),
    true,
  );
  assert.equal(
    appNeedsAttention({
      sharesOwnerCostRail: true,
      ownerUsageStatus: "overage",
    }),
    true,
  );
  assert.equal(
    appNeedsAttention({
      sharesOwnerCostRail: false,
      ownerUsageStatus: "blocked",
    }),
    false,
  );
});

test("status filter blocked is rollup M2M blocked count", () => {
  const blockedApp = {
    blockedM2mUserCount: 3,
    sharesOwnerCostRail: true,
    owner: { usageStatus: "blocked" as const },
  };
  assert.equal(appMatchesStatusFilter(blockedApp, "blocked"), true);
  assert.equal(appMatchesStatusFilter(blockedApp, "attention"), true);
  assert.equal(
    appMatchesStatusFilter(
      { ...blockedApp, blockedM2mUserCount: 0, owner: { usageStatus: "ok" } },
      "blocked",
    ),
    false,
  );
});

test("decideAppUserCreditGrant refuses direct M2M credit on owner rollup", () => {
  const denied = decideAppUserCreditGrant({
    sharesOwnerCostRail: true,
    isPlatformDefault: false,
    ownerUserId: "owner-1",
    externalUserId: "m2m-user",
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.status, 409);
    assert.equal(denied.code, "owner_rollup_credit_owner");
    assert.equal(denied.ownerUserId, "owner-1");
  }
});

test("decideAppUserCreditGrant allows merchant user wallets", () => {
  const allowed = decideAppUserCreditGrant({
    sharesOwnerCostRail: false,
    isPlatformDefault: false,
    ownerUserId: "owner-1",
    externalUserId: "m2m-user",
  });
  assert.deepEqual(allowed, { ok: true, mode: "user_wallet" });
});

test("decideAppUserCreditGrant credits platform-default members as owners", () => {
  const allowed = decideAppUserCreditGrant({
    sharesOwnerCostRail: false,
    isPlatformDefault: true,
    ownerUserId: "app-owner",
    externalUserId: "member-owner",
  });
  assert.deepEqual(allowed, {
    ok: true,
    mode: "self_owner_wallet",
    ownerUserId: "member-owner",
  });
});

test("owner-rollup spendable is prepaid plus remaining included", () => {
  assert.equal(
    ownerRollupSpendableUsdMicros({
      creditBalanceUsdMicros: "2000000",
      includedUsdMicros: "5000000",
      usedUsdMicros: "4000000",
    }),
    "3000000",
  );
  assert.equal(
    ownerRollupSpendableUsdMicros({
      creditBalanceUsdMicros: "0",
      includedUsdMicros: "5000000",
      usedUsdMicros: "5000000",
    }),
    "0",
  );
});
