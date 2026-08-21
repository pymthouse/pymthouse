import {
  OWNER_STARTER_PLAN_NAME,
  isOwnerStarterPlanKey,
} from "@/lib/openmeter/owner-starter-key";
import { planDisplayNameWithStarter } from "@/lib/starter-default-plan-display";

export type AppUserPlanRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  phaseOutAt: string | null;
  replacementPlanId: string | null;
  isStarterDefault?: boolean;
  isNetworkDefault?: boolean;
};

export type AppUserPlanPayload = {
  id: string | null;
  status: string;
  phaseOutAt: string | null;
  replacementPlanId: string | null;
};

export function resolveAppUserSubscriptionPlanName(input: {
  plan: AppUserPlanRow | null;
  planKey: string | null | undefined;
}): string | null {
  if (input.plan) {
    return planDisplayNameWithStarter(input.plan);
  }
  if (isOwnerStarterPlanKey(input.planKey)) {
    return OWNER_STARTER_PLAN_NAME;
  }
  return null;
}

export function buildAppUserSubscriptionPlanPayload(input: {
  plan: AppUserPlanRow | null;
  isOwnerStarter: boolean;
}): AppUserPlanPayload {
  if (input.plan) {
    return {
      id: input.plan.id,
      status: input.plan.status,
      phaseOutAt: input.plan.phaseOutAt ?? null,
      replacementPlanId: input.plan.replacementPlanId ?? null,
    };
  }
  if (input.isOwnerStarter) {
    return {
      id: null,
      status: "active",
      phaseOutAt: null,
      replacementPlanId: null,
    };
  }
  return {
    id: null,
    status: "missing",
    phaseOutAt: null,
    replacementPlanId: null,
  };
}

export function resolveAppUserSubscriptionActionRequired(input: {
  plan: AppUserPlanRow | null;
  isOwnerStarter: boolean;
}): "choose_new_plan" | null {
  const planStatus = input.plan?.status ?? null;
  if ((!input.plan && !input.isOwnerStarter) || planStatus === "phase_out") {
    return "choose_new_plan";
  }
  return null;
}
