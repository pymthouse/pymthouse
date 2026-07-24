function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/** True when OpenMeter has no plan for a stale stored id (update/publish 404). */
export function isOpenMeterPlanNotFoundError(err: unknown): boolean {
  const message = errorMessage(err);
  if (/plan not found/i.test(message) || /\b404\b/.test(message)) {
    return true;
  }
  const status =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  return status === 404;
}

/** True when OpenMeter refuses in-place edits because a plan version is already active. */
export function isOpenMeterPlanImmutableError(err: unknown): boolean {
  const message = errorMessage(err);
  return /only Plans in \[draft scheduled\] can be updated/i.test(message);
}

/** True when a publish is a no-op because the plan version is already active/published. */
export function isOpenMeterPlanAlreadyPublishedError(err: unknown): boolean {
  const message = errorMessage(err);
  return /only Plans in \[draft scheduled\] can be published\/rescheduled/i.test(message);
}

/** True when OpenMeter rejects a duplicate subscription or entitlement for the same feature. */
export function isOpenMeterConflictError(err: unknown): boolean {
  const message = errorMessage(err);
  if (/already exists/i.test(message) || /\b409\b/.test(message)) {
    return true;
  }
  const status =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  return status === 409;
}

/** True when OpenMeter refuses subscription/billing because Stripe app data is missing on the customer. */
export function isOpenMeterStripeBillingError(err: unknown): boolean {
  if (!isOpenMeterConflictError(err)) {
    return false;
  }
  const message = errorMessage(err);
  return (
    /invalid billing setup/i.test(message) ||
    /failed to get stripe customer data/i.test(message) ||
    /customer has no data for stripe app/i.test(message)
  );
}
