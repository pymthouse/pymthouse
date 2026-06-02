import { getHostedOpenMeterClient } from "./client";
import { openMeterUsesLiveNetworkInTests } from "./constants";

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
