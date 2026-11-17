import { hashToken } from "@/domains/identity-access/runtime/request-auth";
import {
  getApiKeyByHash,
  getPlanForSubscription,
  getSubscriptionForApiKey,
  listCapabilitiesForPlan,
} from "../repo/api-key-validation";

export async function validateApiKeyToken(token: string) {
  const apiKey = await getApiKeyByHash(hashToken(token));
  if (!apiKey || apiKey.status !== "active") {
    return { ok: false as const };
  }

  if (!apiKey.subscriptionId) {
    return {
      ok: true as const,
      body: {
        valid: true,
        client_id: apiKey.clientId,
        plan: null,
        allowedModels: [],
      },
    };
  }

  const subscription = await getSubscriptionForApiKey(apiKey.subscriptionId, apiKey.clientId);
  if (!subscription || subscription.status !== "active") {
    return { ok: false as const };
  }

  const plan = await getPlanForSubscription(subscription.planId);
  if (!plan) {
    return { ok: false as const };
  }

  const capabilities = await listCapabilitiesForPlan(plan.id);
  return {
    ok: true as const,
    body: {
      valid: true,
      client_id: apiKey.clientId,
      plan: {
        ...plan,
        includedUnits: plan.includedUnits != null ? plan.includedUnits.toString() : null,
        overageRateWei: plan.overageRateWei != null ? plan.overageRateWei.toString() : null,
      },
      allowedModels: capabilities.map((bundle) => bundle.modelId).filter(Boolean),
    },
  };
}
