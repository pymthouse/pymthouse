/**
 * Path-based app settings tabs.
 * Profile is `/apps/{id}`; other tabs are `/apps/{id}/{tab}`.
 * Callback query params (`connected`, `error`, `connect`, `client`) stay on the path.
 */

export const APP_SETTINGS_TABS = [
  "profile",
  "credentials",
  "plans",
  "payments",
] as const;

export type AppSettingsTab = (typeof APP_SETTINGS_TABS)[number];

const TAB_SET = new Set<string>(APP_SETTINGS_TABS);

export function isAppSettingsTab(value: string | null | undefined): value is AppSettingsTab {
  return Boolean(value && TAB_SET.has(value));
}

/** Resolve aliases from older deep links. */
export function normalizeAppSettingsTab(
  tab: string | null | undefined,
): AppSettingsTab {
  if (tab === "network-discovery") return "plans";
  if (tab === "auth") return "profile";
  if (tab === "billing") return "payments";
  if (isAppSettingsTab(tab)) return tab;
  return "profile";
}

export function appSettingsPath(
  appId: string,
  tab: AppSettingsTab = "profile",
): string {
  const id = encodeURIComponent(appId);
  if (tab === "profile") {
    return `/apps/${id}`;
  }
  return `/apps/${id}/${tab}`;
}

/** Absolute URL for Stripe / activation redirects. */
export function appSettingsAbsoluteUrl(
  origin: string,
  appId: string,
  tab: AppSettingsTab,
  query?: Record<string, string | undefined>,
): string {
  const base = origin.replace(/\/$/, "");
  const path = appSettingsPath(appId, tab);
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== "") {
        params.set(key, value);
      }
    }
  }
  const qs = params.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

/**
 * Tab from `/apps/{id}` or `/apps/{id}/{tab}` pathname.
 * Ignores nested routes like `/apps/{id}/identities/...`.
 */
export function appSettingsTabFromPathname(pathname: string): AppSettingsTab | null {
  const parts = pathname.split("/").filter(Boolean);
  // ["apps", "{id}"] or ["apps", "{id}", "{tab}", ...]
  if (parts[0] !== "apps" || !parts[1]) {
    return null;
  }
  if (!parts[2]) {
    return "profile";
  }
  if (isAppSettingsTab(parts[2])) {
    return parts[2];
  }
  // Nested non-tab routes (identities, usage, …) — not a settings tab page.
  return null;
}
