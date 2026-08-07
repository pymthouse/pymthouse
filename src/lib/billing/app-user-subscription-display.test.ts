import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAppUserSubscriptionPlanPayload,
  resolveAppUserSubscriptionActionRequired,
  resolveAppUserSubscriptionPlanName,
} from "@/lib/billing/app-user-subscription-display";

const paidPlan = {
  id: "plan_1",
  name: "Pro",
  type: "subscription",
  status: "active",
  phaseOutAt: null,
  replacementPlanId: null,
  isStarterDefault: false,
  isNetworkDefault: false,
};

test("resolveAppUserSubscriptionPlanName prefers local plan display name", () => {
  assert.equal(
    resolveAppUserSubscriptionPlanName({
      plan: paidPlan,
      planKey: "other",
    }),
    "Pro",
  );
  assert.equal(
    resolveAppUserSubscriptionPlanName({
      plan: null,
      planKey: "pymthouse_owner_starter",
    }),
    "Owner Sandbox Starter",
  );
  assert.equal(
    resolveAppUserSubscriptionPlanName({ plan: null, planKey: "paid" }),
    null,
  );
});

test("buildAppUserSubscriptionPlanPayload covers local, owner starter, missing", () => {
  assert.deepEqual(
    buildAppUserSubscriptionPlanPayload({
      plan: paidPlan,
      isOwnerStarter: false,
    }),
    {
      id: "plan_1",
      status: "active",
      phaseOutAt: null,
      replacementPlanId: null,
    },
  );
  assert.deepEqual(
    buildAppUserSubscriptionPlanPayload({
      plan: null,
      isOwnerStarter: true,
    }),
    {
      id: null,
      status: "active",
      phaseOutAt: null,
      replacementPlanId: null,
    },
  );
  assert.deepEqual(
    buildAppUserSubscriptionPlanPayload({
      plan: null,
      isOwnerStarter: false,
    }),
    {
      id: null,
      status: "missing",
      phaseOutAt: null,
      replacementPlanId: null,
    },
  );
});

test("resolveAppUserSubscriptionActionRequired flags missing and phase_out", () => {
  assert.equal(
    resolveAppUserSubscriptionActionRequired({
      plan: null,
      isOwnerStarter: false,
    }),
    "choose_new_plan",
  );
  assert.equal(
    resolveAppUserSubscriptionActionRequired({
      plan: { ...paidPlan, status: "phase_out" },
      isOwnerStarter: false,
    }),
    "choose_new_plan",
  );
  assert.equal(
    resolveAppUserSubscriptionActionRequired({
      plan: paidPlan,
      isOwnerStarter: false,
    }),
    null,
  );
  assert.equal(
    resolveAppUserSubscriptionActionRequired({
      plan: null,
      isOwnerStarter: true,
    }),
    null,
  );
});

test("buildAppUserSubscriptionPlanPayload preserves phase-out metadata", () => {
  assert.deepEqual(
    buildAppUserSubscriptionPlanPayload({
      plan: {
        ...paidPlan,
        status: "phase_out",
        phaseOutAt: "2026-09-01T00:00:00.000Z",
        replacementPlanId: "plan_2",
      },
      isOwnerStarter: false,
    }),
    {
      id: "plan_1",
      status: "phase_out",
      phaseOutAt: "2026-09-01T00:00:00.000Z",
      replacementPlanId: "plan_2",
    },
  );
});

test("resolveAppUserSubscriptionPlanName uses starter/network display names", () => {
  assert.equal(
    resolveAppUserSubscriptionPlanName({
      plan: {
        ...paidPlan,
        name: "__pymthouse_starter__",
        isStarterDefault: true,
      },
      planKey: null,
    }),
    "Starter",
  );
  assert.equal(
    resolveAppUserSubscriptionPlanName({
      plan: {
        ...paidPlan,
        name: "__pymthouse_network_default__",
        isNetworkDefault: true,
      },
      planKey: null,
    }),
    "Network Discovery",
  );
});
