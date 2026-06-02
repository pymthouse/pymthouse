/** OpenMeter meter slug for network fee aggregation (USD micros). */
export const NETWORK_FEE_USD_MICROS_METER = "network_fee_usd_micros";

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

/** Usage and balance APIs require a configured OpenMeter instance. */
export function requireOpenMeterForUsageReads(): boolean {
  return isOpenMeterEnabled();
}
