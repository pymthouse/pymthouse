import { OpenMeter } from "@openmeter/sdk";
import { getHostedOpenMeterUrl, isOpenMeterEnabled } from "./constants";
import { createKonnectFetch } from "./konnect-fetch";
import { resolveHostedOpenMeterBaseUrl, shouldUseKonnectRoutes } from "./route-mode";

let hostedClient: OpenMeter | null = null;

export function createOpenMeterClient(input: {
  baseUrl: string;
  apiKey?: string;
}): OpenMeter {
  const apiKey = input.apiKey?.trim() || undefined;
  const rawBaseUrl = input.baseUrl.replace(/\/$/, "");
  const useKonnectRoutes = shouldUseKonnectRoutes(rawBaseUrl, apiKey);
  const baseUrl = useKonnectRoutes ? resolveHostedOpenMeterBaseUrl(apiKey) : rawBaseUrl;
  const clientFetch = useKonnectRoutes ? createKonnectFetch(baseUrl) : undefined;

  if (apiKey) {
    return new OpenMeter({ baseUrl, apiKey, fetch: clientFetch });
  }
  return new OpenMeter({ baseUrl, fetch: clientFetch });
}

export function getHostedOpenMeterClient(): OpenMeter | null {
  if (!isOpenMeterEnabled()) {
    return null;
  }
  if (!hostedClient) {
    const apiKey = process.env.OPENMETER_API_KEY?.trim();
    hostedClient = createOpenMeterClient({
      baseUrl: getHostedOpenMeterUrl(),
      apiKey: apiKey || undefined,
    });
  }
  return hostedClient;
}

export function resetHostedOpenMeterClientForTests(): void {
  hostedClient = null;
}

/** Inject a mock OpenMeter client for unit tests (NODE_ENV=test only). */
export function __testSetHostedOpenMeterClient(client: OpenMeter | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__testSetHostedOpenMeterClient is only available in test");
  }
  hostedClient = client;
}
