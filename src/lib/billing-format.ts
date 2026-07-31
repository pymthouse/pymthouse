/** Client-safe billing display helpers (no Node/DB imports). */

const BILLING_DATE_LOCALE = "en-US";

/**
 * Calendar date for billing UI — fixed locale + UTC so SSR and the browser
 * hydrate to the same string.
 */
export function formatBillingUtcDate(
  iso: string,
  opts?: Readonly<{ month?: "short" | "long"; day?: "numeric"; year?: "numeric" }>,
): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(BILLING_DATE_LOCALE, {
    month: opts?.month ?? "short",
    day: opts?.day ?? "numeric",
    year: opts?.year,
    timeZone: "UTC",
  });
}

export function formatBillingWei(wei: string): string {
  if (!wei || !/^\d+$/.test(wei)) return "0";
  const value = BigInt(wei);
  if (value === 0n) return "0";
  const divisor = 10n ** 18n;
  const whole = value / divisor;
  const remainder = value % divisor;
  if (whole === 0n && remainder > 0n) return `${value.toString()} wei`;
  const fracStr = remainder.toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${fracStr} ETH`;
}

/** Short timezone label for a formatted instant, e.g. `UTC`, `EDT`. */
function timeZoneLabel(date: Date, locale: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
}

/**
 * Billing cycle range, rendered in one timezone and labelled with it.
 *
 * Cycle bounds are computed in UTC. Passing `timeZone: "UTC"` renders them
 * as stored — deterministic, so server and client agree. Omitting `timeZone`
 * renders in the viewer's zone, which is only safe after mount.
 *
 * The label is not decoration: without it, `Jun 30, 8:00 PM — Jul 31, 7:59 PM`
 * and `Jul 1, 12:00 AM — Jul 31, 11:59 PM` are the same cycle and look like
 * different ones.
 */
export function formatCycleRange(
  startIso: string,
  endIso: string,
  options?: Readonly<{ timeZone?: string; locale?: string }>,
): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startIso} — ${endIso}`;
  }
  const locale = options?.locale ?? BILLING_DATE_LOCALE;
  const timeZone = options?.timeZone;
  const format = (date: Date) =>
    new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(date);

  const zone = timeZoneLabel(end, locale, timeZone);
  const range = `${format(start)} — ${format(end)}`;
  return zone ? `${range} ${zone}` : range;
}

export function formatBillingPeriod(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

/**
 * Compact duration from a `billable_secs` meter total (e.g. `4m 12s`, `1h 03m`).
 * Sub-second totals render as `<1s` so metered work never displays as zero.
 */
export function formatBillableDuration(billableSecs: string | null | undefined): string {
  if (billableSecs == null || billableSecs === "") return "—";
  const secs = Number(billableSecs);
  if (!Number.isFinite(secs) || secs < 0) return "—";
  if (secs === 0) return "—";
  if (secs < 1) return "<1s";

  const total = Math.floor(secs);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

/** Short label for when the current billing period resets (e.g. "Jul 31"). */
export function formatPeriodResetLabel(periodEndIso: string): string {
  try {
    const end = new Date(periodEndIso);
    if (Number.isNaN(end.getTime())) return "next period";
    return end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "next period";
  }
}
