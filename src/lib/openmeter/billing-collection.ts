/**
 * Time-based collection cadence for gathering lines.
 *
 * OpenMeter defaults `workflow.collection.alignment` to `subscription`, so on a
 * P1M plan unbilled usage can sit in a gathering invoice for a full month
 * before anything is raised. Anchoring collection to a daily recurring period
 * caps that exposure at roughly 24h without touching the subscription's billing
 * cadence (which governs line periods, not collection).
 *
 * This is the time-based half of collection. The amount-based half is the
 * invoice trigger in `@/lib/billing/invoice-trigger`, which exists because OM's
 * billing workflow has no amount threshold.
 *
 * Note that `collection.interval` is a grace delay applied after the alignment
 * boundary, not a frequency — we leave it at the OM default.
 */

/**
 * A documented `RecurringPeriodIntervalEnum` member, which avoids OM's
 * heuristic ISO-duration parsing for sub-day values.
 */
export const COLLECTION_INTERVAL = "DAY";

/**
 * Anchor on profile creation rather than a shared epoch so tenants collect at
 * staggered times instead of all at once.
 */
function collectionAnchor(anchor?: Date): Date {
  return anchor ?? new Date();
}

/** OpenMeter SDK (camelCase) collection settings. */
export function buildCollectionSettings(anchor?: Date) {
  return {
    alignment: {
      type: "anchored" as const,
      recurringPeriod: {
        interval: COLLECTION_INTERVAL,
        anchor: collectionAnchor(anchor),
      },
    },
  };
}

/** Konnect Billing API (snake_case) collection settings. */
export function buildKonnectCollectionSettings(anchor?: Date) {
  return {
    alignment: {
      type: "anchored",
      recurring_period: {
        interval: COLLECTION_INTERVAL,
        anchor: collectionAnchor(anchor).toISOString(),
      },
    },
  };
}
