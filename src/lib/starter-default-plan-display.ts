/** Client-safe labels for the per-app Starter default plan (no DB imports). */

export const STARTER_DEFAULT_PLAN_INTERNAL_NAME = "__pymthouse_starter__";

export const STARTER_DEFAULT_PLAN_DISPLAY_NAME = "Starter";

export function defaultStarterIncludedUsdMicros(): string {
  const raw = process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    return raw;
  }
  return "5000000";
}

export function planDisplayNameWithStarter(row: {
  name: string;
  isNetworkDefault?: boolean;
  isStarterDefault?: boolean;
}): string {
  if (row.isNetworkDefault) {
    return "Network Discovery";
  }
  if (row.isStarterDefault) {
    return STARTER_DEFAULT_PLAN_DISPLAY_NAME;
  }
  return row.name;
}
