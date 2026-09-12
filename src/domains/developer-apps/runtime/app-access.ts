import type { NextRequest } from "next/server";
import { authenticateAppClient } from "@/domains/identity-access/runtime/request-auth";
import { getProviderApp } from "../repo/provider-access";
import { getAuthorizedProviderApp } from "./provider-access";

export async function getProviderAppForClientOrDashboard(
  request: NextRequest,
  clientId: string,
): Promise<Awaited<ReturnType<typeof getProviderApp>> | null> {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    return getProviderApp(clientId);
  }

  try {
    const providerAuth = await getAuthorizedProviderApp(clientId);
    return providerAuth?.app ?? null;
  } catch {
    return null;
  }
}
