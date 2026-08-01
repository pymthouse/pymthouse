/**
 * Platform-set defaults for the cost-rail controls.
 *
 * `end_user_cap` and `application_fee_bps` protect PymtHouse, not the Builder,
 * so they are admin-only on the API (see platform-controlled-fields). These are
 * the values a new app inherits. Keeping them here rather than only as column
 * defaults means changing platform policy is an env change, not a migration,
 * and the per-app columns read as explicit admin overrides.
 *
 * See docs/adr-owner-vs-app-billing.md.
 */

/** Column default in `app_billing_config`; the floor if env is unset/invalid. */
export const FALLBACK_END_USER_CAP = 25;
export const FALLBACK_APPLICATION_FEE_BPS = 0;

const MAX_END_USER_CAP = 1_000_000;
/** 10_000 bps = 100%. */
const MAX_APPLICATION_FEE_BPS = 10_000;

/** Only the two keys below are read; a plain record keeps this testable. */
type EnvSource = Readonly<Record<string, string | undefined>>;

function readBoundedInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

/**
 * End-user cap a newly provisioned app starts on.
 * `PYMTHOUSE_DEFAULT_END_USER_CAP`, clamped to [1, 1_000_000].
 */
export function platformDefaultEndUserCap(
  env: EnvSource = process.env,
): number {
  return readBoundedInt(
    env.PYMTHOUSE_DEFAULT_END_USER_CAP,
    1,
    MAX_END_USER_CAP,
    FALLBACK_END_USER_CAP,
  );
}

/**
 * Platform fee a newly connected merchant starts on.
 * `PYMTHOUSE_DEFAULT_APPLICATION_FEE_BPS`, clamped to [0, 10_000].
 */
export function platformDefaultApplicationFeeBps(
  env: EnvSource = process.env,
): number {
  return readBoundedInt(
    env.PYMTHOUSE_DEFAULT_APPLICATION_FEE_BPS,
    0,
    MAX_APPLICATION_FEE_BPS,
    FALLBACK_APPLICATION_FEE_BPS,
  );
}
