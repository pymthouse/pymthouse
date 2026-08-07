function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/**
 * Konnect problem bodies often omit `detail`, so the OpenMeter SDK renders
 * "[409]: undefined" and the real reason is lost. Fold the problem `title`,
 * `type` and raw body into the log line so conflicts stay diagnosable.
 */
export function describeOpenMeterError(err: unknown): string {
  const parts = [errorMessage(err) || String(err)];
  const problem = err as {
    title?: string;
    type?: string;
    __raw?: unknown;
  };
  if (problem.title) {
    parts.push(`title=${problem.title}`);
  }
  if (problem.type) {
    parts.push(`type=${problem.type}`);
  }
  if (problem.__raw !== undefined) {
    try {
      parts.push(`raw=${JSON.stringify(problem.__raw)}`);
    } catch {
      /* non-serializable problem body */
    }
  }
  return parts.join(" | ");
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
  // Konnect often returns "conflict error: …" without attaching HTTP status on the SDK Error.
  if (
    /already exists/i.test(message) ||
    /\b409\b/.test(message) ||
    /conflict error/i.test(message)
  ) {
    return true;
  }
  const status =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  return status === 409;
}

function isStripeBillingSetupMessage(message: string): boolean {
  return (
    /invalid billing setup/i.test(message) ||
    /failed to get stripe customer data/i.test(message) ||
    /customer has no data for stripe app/i.test(message) ||
    /customers need a default payment method/i.test(message)
  );
}

/** True when OpenMeter refuses subscription/billing because Stripe app data is missing on the customer. */
export function isOpenMeterStripeBillingError(err: unknown): boolean {
  const message = errorMessage(err);
  if (!isStripeBillingSetupMessage(message)) {
    return false;
  }
  // Prefer conflict classification, but accept message-only Konnect bodies (no .status).
  if (isOpenMeterConflictError(err)) {
    return true;
  }
  const status =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  return status === undefined || status === 409 || status === 412;
}
