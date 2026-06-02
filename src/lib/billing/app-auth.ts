import type { NextRequest } from "next/server";
import { authenticateAppClient } from "@/lib/auth";
import { getAuthorizedProviderApp, getProviderApp } from "@/lib/provider-apps";

export async function authorizeAppForBilling(
  request: NextRequest,
  clientId: string,
): Promise<{ app: NonNullable<Awaited<ReturnType<typeof getProviderApp>>> } | null> {
  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const app = await getProviderApp(clientId);
    return app ? { app } : null;
  }
  try {
    const providerAuth = await getAuthorizedProviderApp(clientId, request);
    return providerAuth ? { app: providerAuth.app } : null;
  } catch {
    return null;
  }
}
