/**
 * Plain-language reading of an app's mid-cycle invoicing settings.
 *
 * "Progressive billing on" with a blank threshold is a legal but ambiguous
 * state — the checkbox alone does not say when invoicing happens. Rendering the
 * resolved behaviour avoids the reader inferring it from an empty field.
 *
 * Client-safe (no DB/Node imports).
 */
export function resolvedInvoicingBehavior(
  progressiveBilling: boolean,
  thresholdDisplay: string,
): string {
  if (!progressiveBilling) {
    return "Off — usage is invoiced once, at the end of each billing cycle.";
  }
  const threshold = thresholdDisplay.trim();
  if (!threshold) {
    return "On — invoicing at cycle end (no mid-cycle threshold set).";
  }
  return `On — invoicing mid-cycle once unpaid usage reaches $${threshold}.`;
}
