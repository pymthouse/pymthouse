import {
  getHostedOpenMeterUrl,
  isKonnectMeteringUrl,
  normalizeKonnectMeteringUrl,
} from "./constants";

export type OpenMeterRouteMode = "auto" | "self_hosted" | "hosted";

export function getOpenMeterRouteMode(): OpenMeterRouteMode {
  const raw = process.env.OPENMETER_ROUTE_MODE?.trim().toLowerCase();
  if (raw === "hosted" || raw === "self_hosted" || raw === "auto") {
    return raw;
  }
  return "auto";
}

export function shouldUseKonnectRoutes(baseUrl: string, apiKey?: string): boolean {
  const routeMode = getOpenMeterRouteMode();
  if (routeMode === "hosted") {
    return true;
  }
  if (routeMode === "self_hosted") {
    return false;
  }
  return isKonnectMeteringUrl(baseUrl, apiKey);
}

export function resolveHostedOpenMeterBaseUrl(apiKey?: string): string {
  const rawBaseUrl = getHostedOpenMeterUrl();
  if (shouldUseKonnectRoutes(rawBaseUrl, apiKey)) {
    return normalizeKonnectMeteringUrl(rawBaseUrl);
  }
  return rawBaseUrl;
}

/** Block SSRF: Konnect fetch wrapper may only call the configured metering origin. */
export function assertKonnectFetchOrigin(targetUrl: string, allowedBaseUrl: string): void {
  const target = new URL(targetUrl);
  const allowed = new URL(allowedBaseUrl);
  if (target.origin !== allowed.origin) {
    throw new Error("OpenMeter Konnect fetch blocked: unexpected origin");
  }
}
