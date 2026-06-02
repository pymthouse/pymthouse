import { OpenMeter } from "@openmeter/sdk";
import { getHostedOpenMeterUrl, isOpenMeterEnabled } from "./constants";

let hostedClient: OpenMeter | null = null;

export function createOpenMeterClient(input: {
  baseUrl: string;
  apiKey?: string;
}): OpenMeter {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  if (input.apiKey?.trim()) {
    return new OpenMeter({ baseUrl, apiKey: input.apiKey.trim() });
  }
  return new OpenMeter({ baseUrl });
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
