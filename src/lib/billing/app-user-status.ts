/**
 * Lifecycle statuses for provisioned M2M `app_users`.
 *
 * - `active` — counts toward the per-app end-user cap; can mint tokens / keys
 * - `inactive` — soft-deactivated (DELETE …/users); frees a cap slot; auth blocked
 */

export const APP_USER_STATUSES = ["active", "inactive"] as const;

export type AppUserStatus = (typeof APP_USER_STATUSES)[number];

export function isAppUserStatus(value: unknown): value is AppUserStatus {
  return value === "active" || value === "inactive";
}

export function parseAppUserStatus(
  value: unknown,
): { ok: true; status: AppUserStatus } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return {
      ok: false,
      error: `status must be one of: ${APP_USER_STATUSES.join(", ")}`,
    };
  }
  const normalized = value.trim().toLowerCase();
  if (!isAppUserStatus(normalized)) {
    return {
      ok: false,
      error: `status must be one of: ${APP_USER_STATUSES.join(", ")}`,
    };
  }
  return { ok: true, status: normalized };
}
