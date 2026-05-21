/** Client-safe labels for the per-app Network Price default plan (no DB imports). */

export const NETWORK_DEFAULT_PLAN_INTERNAL_NAME = "__pymthouse_network_default__";

export const NETWORK_DEFAULT_PLAN_DISPLAY_NAME = "Network Discovery";

export function planDisplayName(row: { name: string; isNetworkDefault: boolean }): string {
  return row.isNetworkDefault ? NETWORK_DEFAULT_PLAN_DISPLAY_NAME : row.name;
}
