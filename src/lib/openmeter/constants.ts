/** OpenMeter meter slug for network fee aggregation (USD picos; 1 USD = 1e12). */
export const NETWORK_FEE_USD_PICOS_METER = "network_fee_usd_picos";

/** OpenMeter meter slug for network fee aggregation (USD nanos; 1 USD = 1e9). */
export const NETWORK_FEE_USD_NANOS_METER = "network_fee_usd_nanos";

/**
 * Legacy network-fee meter (USD micros). Historical usage before the nanos cutover
 * still lives here. Usage reads: micros|nanos before the picos hard cutover, then
 * picos only. Collector dual-emits micros until NETWORK_FEE_MICROS_EMIT_DEPRECATE_AFTER.
 */
export const NETWORK_FEE_USD_MICROS_METER = "network_fee_usd_micros";

/**
 * Stop dual-emitting `network_fee_usd_micros` from the collector on/after this date
 * (2026-07-10 cutover + 2 months). Legacy meter stays for historical reads.
 */
export const NETWORK_FEE_MICROS_EMIT_DEPRECATE_AFTER = new Date("2026-09-10T00:00:00.000Z");

/** 1 USD micro = 1_000 USD nanos. */
export const USD_NANOS_PER_MICRO = 1000n;

/** 1 USD nano = 1_000 USD picos. */
export const USD_PICOS_PER_NANO = 1000n;

/** 1 USD micro = 1_000_000 USD picos. */
export const USD_PICOS_PER_MICRO = 1_000_000n;

/** 1 USD = 1_000_000_000_000 USD picos. */
export const USD_PICOS_PER_DOLLAR = 1_000_000_000_000n;

export function usdNanosToMicros(nanos: bigint): bigint {
  return nanos / USD_NANOS_PER_MICRO;
}

export function usdMicrosToNanos(micros: bigint): bigint {
  return micros * USD_NANOS_PER_MICRO;
}

export function usdPicosToMicros(picos: bigint): bigint {
  return picos / USD_PICOS_PER_MICRO;
}

export function usdMicrosToPicos(micros: bigint): bigint {
  return micros * USD_PICOS_PER_MICRO;
}

export function usdPicosToNanos(picos: bigint): bigint {
  return picos / USD_PICOS_PER_NANO;
}

/**
 * Mirror collector fee mapping: ceil(fee_wei * eth_usd / 1e6), min 1 when fee_wei > 0.
 * ethUsd is the ETH/USD spot (e.g. 3500).
 */
export function feeWeiToUsdPicos(feeWei: bigint, ethUsd: number): bigint {
  if (feeWei <= 0n || !(ethUsd > 0) || !Number.isFinite(ethUsd)) {
    return 0n;
  }
  const raw = (Number(feeWei) * ethUsd) / 1e6;
  const picos = BigInt(Math.ceil(raw));
  return picos < 1n ? 1n : picos;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Instant when `network_fee_usd_nanos` became the authoritative fee meter.
 * Override with OPENMETER_NETWORK_FEE_NANOS_CUTOVER_AT (ISO-8601).
 * Default: day of the nanos meter cutover (#220).
 */
export function getNetworkFeeNanosCutoverAt(env: EnvLike = process.env): Date {
  const raw = env.OPENMETER_NETWORK_FEE_NANOS_CUTOVER_AT?.trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date("2026-07-10T00:00:00.000Z");
}

/**
 * Hard cutover: `network_fee_usd_picos` becomes the only fee meter written/read
 * for new usage. Pre-cutover history stays on micros|nanos. Override with
 * OPENMETER_NETWORK_FEE_PICOS_CUTOVER_AT (ISO-8601).
 */
export function getNetworkFeePicosCutoverAt(env: EnvLike = process.env): Date {
  const raw = env.OPENMETER_NETWORK_FEE_PICOS_CUTOVER_AT?.trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date("2026-07-11T00:00:00.000Z");
}

/** Fixed date to stop dual-emitting legacy micros fields from the collector. */
export function getNetworkFeeMicrosEmitDeprecateAfter(): Date {
  return NETWORK_FEE_MICROS_EMIT_DEPRECATE_AFTER;
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
