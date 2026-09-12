import type { NextRequest } from "next/server";
import { authenticateAppClient } from "@/domains/identity-access/runtime/request-auth";
import { getProviderApp } from "@/domains/developer-apps/repo/provider-access";
import { getAuthorizedProviderApp } from "@/domains/developer-apps/runtime/provider-access";
import { resolvePlansDiscoveryForApp } from "./discovery-resolution";

export async function resolveReadablePlansApp(clientId: string, request: NextRequest) {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    return getProviderApp(clientId);
  }
  if (clientAuth) return null;

  const auth = await getAuthorizedProviderApp(clientId);
  return auth?.app ?? null;
}

export async function readResolvedPlans(clientId: string, appId: string) {
  const resolved = await resolvePlansDiscoveryForApp(appId);
  return resolved.map((r) => {
    const plan = r.plan;
    return {
      ...plan,
      discoveryProfileId: plan.discoveryProfileId ?? null,
      discoveryPolicy: r.discoveryPolicy,
      includedUnits:
        plan.includedUnits !== null && plan.includedUnits !== undefined
          ? plan.includedUnits.toString()
          : null,
      overageRateWei:
        plan.overageRateWei !== null && plan.overageRateWei !== undefined
          ? plan.overageRateWei.toString()
          : null,
      clientId,
      capabilities: r.capabilities.map((c) => ({
        ...c,
        clientId,
      })),
    };
  });
}

export async function readActiveDiscoveryPlans(appId: string) {
  const resolved = await resolvePlansDiscoveryForApp(appId);
  return resolved
    .filter((r) => r.plan.status === "active")
    .map((r) => ({
      id: r.plan.id,
      name: r.plan.name,
      status: r.plan.status,
      discoveryPolicy: r.discoveryPolicy,
      capabilities: r.capabilities.map((c) => ({
        pipeline: c.pipeline,
        modelId: c.modelId,
        discoveryPolicy: c.discoveryPolicy,
      })),
    }));
}
