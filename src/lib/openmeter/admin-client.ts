import { getHostedOpenMeterClient, createOpenMeterClient } from "./client";
import { openMeterUsesLiveNetworkInTests } from "./constants";
import {
  getOpenMeterClientForApp,
  resolveAppOpenMeterConfig,
} from "./client-factory";
import type { OpenMeter } from "@openmeter/sdk";

/** Platform admin OpenMeter client for tenant billing mutations only. */
export function getHostedAdminClient() {
  const client = getHostedOpenMeterClient();
  if (!client) {
    throw new Error(
      "OpenMeter is not configured (set OPENMETER_URL; OPENMETER_API_KEY only for secured deployments)",
    );
  }
  return client;
}

export function isHostedAdminClientAvailable(): boolean {
  if (process.env.NODE_ENV === "test" && !openMeterUsesLiveNetworkInTests()) {
    return false;
  }
  return getHostedOpenMeterClient() !== null;
}

/**
 * Resolve the OpenMeter client used for billing writes (plans, subscriptions, Stripe).
 * BYO apps use their configured endpoint; hosted apps use the platform admin client.
 */
export async function getBillingClientForApp(clientId: string): Promise<OpenMeter> {
  const config = await resolveAppOpenMeterConfig(clientId);
  if (config.mode === "pymthouse_hosted") {
    return getHostedAdminClient();
  }
  const client = await getOpenMeterClientForApp(clientId);
  if (!client) {
    throw new Error(`BYO OpenMeter client unavailable for app ${clientId}`);
  }
  return client;
}

export async function isBillingClientAvailableForApp(clientId: string): Promise<boolean> {
  try {
    const config = await resolveAppOpenMeterConfig(clientId);
    if (config.mode === "pymthouse_hosted") {
      return isHostedAdminClientAvailable();
    }
    return Boolean(config.baseUrl?.trim());
  } catch {
    return false;
  }
}

/** Create an ephemeral client from explicit BYO credentials (tests / scripts). */
export function createBillingClientFromConfig(input: {
  baseUrl: string;
  apiKey?: string;
}): OpenMeter {
  return createOpenMeterClient({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });
}
