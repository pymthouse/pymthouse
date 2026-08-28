/** Client-safe labels for the per-app Starter default plan (no DB imports). */

export const STARTER_DEFAULT_PLAN_INTERNAL_NAME = "__pymthouse_starter__";

export const STARTER_DEFAULT_PLAN_DISPLAY_NAME = "Starter";

/** Starter uses `draft` to disable auto-enrollment without deleting the row. */
export const STARTER_PLAN_DISABLED_STATUS = "draft";

export const STARTER_PLAN_ENABLED_STATUS = "active";

export function isStarterPlanEnabled(status: string | null | undefined): boolean {
  return status === STARTER_PLAN_ENABLED_STATUS;
}

/**
 * Seed amount for new app / M2M Starter plan rows (`plans.included_usd_micros`).
 * Owner Starter uses `platform_billing_settings` — do not reuse this helper there.
 */
export function defaultStarterIncludedUsdMicros(): string {
  const raw = process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    return raw;
  }
  return "0";
}

/**
 * Parse included USD micros. Returns null only when unset or invalid.
 * An explicit `"0"` is `0n` — it is not treated as missing.
 */
export function parseIncludedUsdMicros(raw: string | null | undefined): bigint | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
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
    const trimmed = row.name.trim();
    if (!trimmed || trimmed === STARTER_DEFAULT_PLAN_INTERNAL_NAME) {
      return STARTER_DEFAULT_PLAN_DISPLAY_NAME;
    }
    return trimmed;
  }
  return row.name;
}

/**
 * True when `name` is the Starter row's current display name or its internal
 * seed name. Used so custom plans cannot collide with Starter after a rename.
 */
export function isNameTakenByStarter(
  name: string,
  starter: { name: string } | null | undefined,
): boolean {
  if (name === STARTER_DEFAULT_PLAN_INTERNAL_NAME) {
    return true;
  }
  if (!starter) {
    return name === STARTER_DEFAULT_PLAN_DISPLAY_NAME;
  }
  return planDisplayNameWithStarter({
    name: starter.name,
    isStarterDefault: true,
  }) === name;
}
