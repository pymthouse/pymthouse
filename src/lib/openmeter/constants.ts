/** OpenMeter meter slug for network fee aggregation (USD nanos; 1 USD = 1e9). */
export const NETWORK_FEE_USD_NANOS_METER = "network_fee_usd_nanos";

/** @deprecated Use NETWORK_FEE_USD_NANOS_METER. Kept as alias for older app meterSlug rows. */
export const NETWORK_FEE_USD_MICROS_METER = NETWORK_FEE_USD_NANOS_METER;

/** 1 USD micro = 1_000 USD nanos. Meter stores nanos; app ledger/UI stays in micros. */
export const USD_NANOS_PER_MICRO = 1000n;

export function usdNanosToMicros(nanos: bigint): bigint {
  return nanos / USD_NANOS_PER_MICRO;
}

export function usdMicrosToNanos(micros: bigint): bigint {
  return micros * USD_NANOS_PER_MICRO;
}

/** OpenMeter meter slug for signed-ticket request counts. */
export const SIGNED_TICKET_COUNT_METER = "signed_ticket_count";

/** CloudEvent type for go-livepeer signed tickets. */
export const CREATE_SIGNED_TICKET_EVENT_TYPE = "create_signed_ticket";

/** CloudEvent source identifier for pymthouse / go-livepeer ingest. */
export const SIGNED_TICKET_EVENT_SOURCE = "go-livepeer-remote-signer";

/** OpenMeter feature key for trial credit entitlements. */
export const DEFAULT_TRIAL_FEATURE_KEY =
  process.env.OPENMETER_TRIAL_FEATURE_KEY?.trim() || "network_spend";

export type OpenMeterBackendMode =
  | "pymthouse_hosted"
  | "byo_openmeter_cloud"
  | "byo_openmeter_self_hosted";

export function isOpenMeterEnabled(): boolean {
  return Boolean(process.env.OPENMETER_URL?.trim());
}

export function getHostedOpenMeterUrl(): string {
  return (process.env.OPENMETER_URL?.trim() || "http://127.0.0.1:48888").replace(/\/$/, "");
}

export function isKonnectMeteringUrl(url: string, apiKey?: string): boolean {
  if (/konghq\.com/i.test(url)) {
    return true;
  }
  const key = apiKey?.trim() ?? "";
  return key.startsWith("kpat_") || key.startsWith("spat_");
}

/** Normalize OPENMETER_URL to the Konnect metering base (…/v3/openmeter). */
export function normalizeKonnectMeteringUrl(url: string): string {
  let base = url.trim().replace(/\/$/, "");
  if (base.endsWith("/events")) {
    base = base.slice(0, -"/events".length);
  }
  if (!base.endsWith("/openmeter") && /\/v\d+$/i.test(base)) {
    base = `${base}/openmeter`;
  }
  return base;
}

/** Usage and balance APIs require a configured OpenMeter instance. */
export function requireOpenMeterForUsageReads(): boolean {
  return isOpenMeterEnabled();
}

/** When false in NODE_ENV=test, OpenMeter reads/writes use in-memory stubs only. */
export function openMeterUsesLiveNetworkInTests(): boolean {
  return process.env.OPENMETER_TEST_LIVE === "1";
}
