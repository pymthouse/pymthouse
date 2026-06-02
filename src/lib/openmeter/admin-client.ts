import { getHostedOpenMeterClient } from "./client";

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
  return getHostedOpenMeterClient() !== null;
}
