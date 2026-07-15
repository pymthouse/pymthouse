import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyOwnerSubscriptionMapping,
  classifySpendableGateConsistency,
  classifyStarterPlanRemoteConsistency,
  readUsageDiscountUsdMicrosFromPlanBody,
  summarizeFindings,
  type LocalStarterPlanRef,
} from "./billing-consistency";
import { includedDiscountUsdMicrosForPlan } from "./spendable-allowance";
import { mintAllowanceGateDecision } from "@/lib/oidc/mint-user-signer-token";

const starterLocal = (overrides: Partial<LocalStarterPlanRef> = {}): LocalStarterPlanRef => ({
  planId: "plan-local-1",
  developerAppId: "app_aaaaaaaaaaaaaaaaaaaaaaaa",
  publicClientId: "app_aaaaaaaaaaaaaaaaaaaaaaaa",
  appName: "Test App",
  includedUsdMicros: "5000000",
  openmeterPlanId: "01LOCALSTARTERPLAN00000001",
  planKey: "app_aaaaaaaaaaaaaaaaaaaaaaaa:plan-local-1",
  ...overrides,
});

test("readUsageDiscountUsdMicrosFromPlanBody reads snake_case rate_cards", () => {
  const micros = readUsageDiscountUsdMicrosFromPlanBody({
    phases: [
      {
        rate_cards: [{ discounts: { usage: "5000000" } }],
      },
    ],
  });
  assert.equal(micros, "5000000");
});

test("readUsageDiscountUsdMicrosFromPlanBody reads SDK camelCase rateCards", () => {
  const micros = readUsageDiscountUsdMicrosFromPlanBody({
    phases: [
      {
        rateCards: [{ discounts: { usage: 2500000 } }],
      },
    ],
  });
  assert.equal(micros, "2500000");
});

test("includedDiscountUsdMicrosForPlan uses plan micros then starter default", () => {
  assert.equal(
    includedDiscountUsdMicrosForPlan({
      includedUsdMicros: "5000000",
      isStarterDefault: true,
    }),
    5_000_000n,
  );
  assert.equal(
    includedDiscountUsdMicrosForPlan({
      includedUsdMicros: null,
      isStarterDefault: false,
    }),
    null,
  );
});

test("classifyStarterPlanRemoteConsistency flags missing remote discount", () => {
  const findings = classifyStarterPlanRemoteConsistency({
    local: starterLocal(),
    remote: {
      id: "01LOCALSTARTERPLAN00000001",
      key: starterLocal().planKey,
      version: 3,
      usageDiscountUsdMicros: null,
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "starter_missing_usage_discount");
  assert.equal(findings[0]?.severity, "error");
});

test("classifyStarterPlanRemoteConsistency ok when discount matches", () => {
  const local = starterLocal();
  const findings = classifyStarterPlanRemoteConsistency({
    local,
    remote: {
      id: local.openmeterPlanId!,
      key: local.planKey,
      version: 3,
      usageDiscountUsdMicros: "5000000",
    },
  });
  assert.deepEqual(findings, []);
});

test("classifyOwnerSubscriptionMapping detects stale plan version", () => {
  const local = starterLocal();
  const findings = classifyOwnerSubscriptionMapping({
    ownerId: "owner-1",
    subscription: {
      id: "sub-1",
      status: "active",
      planId: "01OLDSTARTERPLANVERSION0001",
      planKey: null,
    },
    remotePlan: {
      id: "01OLDSTARTERPLANVERSION0001",
      key: local.planKey,
      version: 1,
      usageDiscountUsdMicros: null,
    },
    ownedStarters: [local],
  });
  assert.equal(findings[0]?.code, "starter_subscription_stale_plan_version");
});

test("classifyOwnerSubscriptionMapping detects unmapped foreign plan", () => {
  const local = starterLocal();
  const findings = classifyOwnerSubscriptionMapping({
    ownerId: "owner-1",
    subscription: {
      id: "sub-1",
      status: "active",
      planId: "01OTHERAPPSTARTERPLAN000001",
      planKey: "other_app_plan_xyz",
    },
    remotePlan: {
      id: "01OTHERAPPSTARTERPLAN000001",
      key: "other_app_plan_xyz",
      usageDiscountUsdMicros: null,
    },
    ownedStarters: [local],
  });
  assert.equal(findings[0]?.code, "owner_subscription_unmapped_plan");
});

test("classifyOwnerSubscriptionMapping accepts platform Owner Starter", () => {
  const findings = classifyOwnerSubscriptionMapping({
    ownerId: "owner-1",
    subscription: {
      id: "sub-1",
      status: "active",
      planId: "01OWNERSTARTERPLAN0000000001",
      planKey: "pymthouse_owner_starter",
    },
    remotePlan: {
      id: "01OWNERSTARTERPLAN0000000001",
      key: "pymthouse_owner_starter",
      usageDiscountUsdMicros: "5000000",
    },
    ownedStarters: [starterLocal()],
  });
  assert.deepEqual(findings, []);
});

test("classifyOwnerSubscriptionMapping warns on legacy per-app Starter", () => {
  const local = starterLocal();
  const findings = classifyOwnerSubscriptionMapping({
    ownerId: "owner-1",
    subscription: {
      id: "sub-1",
      status: "active",
      planId: local.openmeterPlanId,
      planKey: local.planKey,
    },
    remotePlan: {
      id: local.openmeterPlanId!,
      key: local.planKey,
      usageDiscountUsdMicros: "5000000",
    },
    ownedStarters: [local],
  });
  assert.equal(findings[0]?.code, "owner_subscription_legacy_app_starter");
  assert.equal(findings[0]?.severity, "warn");
});

test("classifySpendableGateConsistency catches unused allowance with zero spendable", () => {
  const findings = classifySpendableGateConsistency({
    ownerId: "owner-1",
    clientId: "app_aaaaaaaaaaaaaaaaaaaaaaaa",
    expectedIncludedUsdMicros: 5_000_000n,
    usedUsdMicros: 138_382n,
    creditBalanceUsdMicros: 0n,
    discountRemainingUsdMicros: 0n,
    spendableUsdMicros: 0n,
  });
  assert.equal(findings[0]?.code, "spendable_gate_blocks_with_unused_allowance");
  assert.equal(findings[0]?.severity, "error");
});

test("classifySpendableGateConsistency quiet when spendable covers unused allowance", () => {
  const findings = classifySpendableGateConsistency({
    ownerId: "owner-1",
    clientId: "app_aaaaaaaaaaaaaaaaaaaaaaaa",
    expectedIncludedUsdMicros: 5_000_000n,
    usedUsdMicros: 138_382n,
    creditBalanceUsdMicros: 0n,
    discountRemainingUsdMicros: 4_861_618n,
    spendableUsdMicros: 4_861_618n,
  });
  assert.deepEqual(findings, []);
});

test("mintAllowanceGateDecision rejects zero spendable like the live 483 path", () => {
  const decision = mintAllowanceGateDecision(
    {
      hasAccess: false,
      balanceUsdMicros: "0",
      consumedUsdMicros: "0",
      lifetimeGrantedUsdMicros: "0",
    },
    true,
  );
  assert.equal(decision?.code, "trial_credits_exhausted");
  assert.equal(decision?.message, "Starter allowance exhausted");
});

test("summarizeFindings counts severities", () => {
  assert.deepEqual(
    summarizeFindings([
      {
        code: "a",
        severity: "error",
        message: "e",
      },
      {
        code: "b",
        severity: "warn",
        message: "w",
      },
      {
        code: "c",
        severity: "info",
        message: "i",
      },
    ]),
    { errors: 1, warns: 1, infos: 1 },
  );
});
