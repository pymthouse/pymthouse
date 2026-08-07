/**
 * Shared Konnect/OpenMeter subscription state machine.
 *
 * Owner wallet and app-user (M2M) billing both need the same transitions.
 * Keep status predicates + classification here so cancel/change/resume never
 * target a `scheduled` row (Konnect 403: "transition cancel in state scheduled
 * not allowed").
 */

import {
  cancelKonnectSubscription,
  deleteKonnectSubscription,
  restoreKonnectSubscription,
  unscheduleKonnectSubscriptionCancelation,
} from "./konnect-subscriptions";
import type { OpenMeterSubscriptionView } from "./subscription-read";

/** Live rows — legal targets for `/change` and `/cancel`. */
export function isLiveSubscriptionStatus(
  status: string | null | undefined,
): boolean {
  const s = (status || "").trim().toLowerCase();
  // Empty/unknown must NOT count as live — Konnect rejects /cancel|/change on
  // `scheduled`, and mis-classifying blanks as live caused staging 403s.
  return s === "active" || s === "trialing";
}

/**
 * Scheduled/pending successors — only `DELETE` (or restore of the prior sub)
 * is legal. Never pass these to `/change` or `/cancel`.
 */
export function isScheduledSubscriptionStatus(
  status: string | null | undefined,
): boolean {
  const s = (status || "").toLowerCase();
  return s === "scheduled" || s === "pending";
}

export function isCanceledSubscriptionStatus(
  status: string | null | undefined,
): boolean {
  const s = (status || "").toLowerCase();
  // Konnect also uses `inactive` for cancel-at-period-end rows that still
  // occupy the customer slot until `activeTo`.
  return s === "canceled" || s === "cancelled" || s === "inactive";
}

/**
 * True when a canceled/inactive row still blocks `subscriptions.create`
 * (`only_single_subscription_allowed_per_customer_at_a_time`) because its
 * billing period has not ended yet.
 */
export function isOccupyingCanceledSubscription(
  subscription: Pick<OpenMeterSubscriptionView, "status" | "activeTo">,
  nowMs: number = Date.now(),
): boolean {
  if (!isCanceledSubscriptionStatus(subscription.status)) {
    return false;
  }
  const activeTo = subscription.activeTo?.trim();
  if (!activeTo) {
    return false;
  }
  const endMs = Date.parse(activeTo);
  return !Number.isNaN(endMs) && endMs > nowMs;
}

/** First canceled/inactive subscription whose `activeTo` is still in the future. */
export function pickOccupyingCanceledSubscription(
  listed: OpenMeterSubscriptionView[],
): OpenMeterSubscriptionView | undefined {
  return listed.find(
    (sub) => Boolean(sub.id) && isOccupyingCanceledSubscription(sub),
  );
}

/**
 * Cancel-at-period-end rows still occupy the customer until `activeTo`.
 * Prefer unschedule-cancelation; fall back to restore (also clears successors).
 */
export async function reactivateOccupyingCanceledSubscription(
  subscriptionId: string,
): Promise<void> {
  const id = subscriptionId.trim();
  if (!id) {
    return;
  }
  try {
    await unscheduleKonnectSubscriptionCancelation({ subscriptionId: id });
    return;
  } catch (unscheduleErr) {
    console.warn(
      "subscription-state: unschedule cancelation failed, trying restore",
      id,
      unscheduleErr instanceof Error ? unscheduleErr.message : unscheduleErr,
    );
  }
  await restoreKonnectSubscription({ subscriptionId: id });
}

/**
 * Present for display / existence (live OR scheduled). Not a mutation target.
 * Matches historical `isOpenMeterSubscriptionActive` semantics.
 */
export function isPresentSubscriptionStatus(
  status: string | null | undefined,
): boolean {
  return (
    isLiveSubscriptionStatus(status) || isScheduledSubscriptionStatus(status)
  );
}

export type StarterMatcher = (sub: OpenMeterSubscriptionView) => boolean;

export type ClassifiedSubscriptions = {
  livePaid: OpenMeterSubscriptionView | undefined;
  /** Paid plan that has not started yet — only DELETE is legal (not /cancel). */
  scheduledPaid: OpenMeterSubscriptionView | undefined;
  canceledPaid: OpenMeterSubscriptionView | undefined;
  liveStarter: OpenMeterSubscriptionView | undefined;
  scheduledStarter: OpenMeterSubscriptionView | undefined;
  /** All scheduled/pending subscription ids (any plan). */
  scheduledIds: string[];
};

function firstMatch(
  listed: OpenMeterSubscriptionView[],
  predicate: (sub: OpenMeterSubscriptionView) => boolean,
): OpenMeterSubscriptionView | undefined {
  return listed.find((sub) => Boolean(sub.id) && predicate(sub));
}

/**
 * Partition listed subscriptions for cancel / change / resume decisions.
 * `isStarter` is the only surface-specific hook (owner vs app-user starter).
 */
export function classifySubscriptions(
  listed: OpenMeterSubscriptionView[],
  isStarter: StarterMatcher,
): ClassifiedSubscriptions {
  const withId = listed.filter((sub) => Boolean(sub.id));

  return {
    livePaid: firstMatch(
      withId,
      (sub) => isLiveSubscriptionStatus(sub.status) && !isStarter(sub),
    ),
    scheduledPaid: firstMatch(
      withId,
      (sub) => isScheduledSubscriptionStatus(sub.status) && !isStarter(sub),
    ),
    canceledPaid: firstMatch(
      withId,
      (sub) => isCanceledSubscriptionStatus(sub.status) && !isStarter(sub),
    ),
    liveStarter: firstMatch(
      withId,
      (sub) => isLiveSubscriptionStatus(sub.status) && isStarter(sub),
    ),
    scheduledStarter: firstMatch(
      withId,
      (sub) => isScheduledSubscriptionStatus(sub.status) && isStarter(sub),
    ),
    scheduledIds: withId
      .filter((sub) => isScheduledSubscriptionStatus(sub.status))
      .map((sub) => sub.id),
  };
}

/** Prefer any live row for Konnect `/change`. Never returns scheduled. */
export function pickLiveSubscription(
  listed: OpenMeterSubscriptionView[],
): OpenMeterSubscriptionView | null {
  return (
    listed.find(
      (s) => Boolean(s.id) && isLiveSubscriptionStatus(s.status),
    ) ?? null
  );
}

export function listScheduledSubscriptionIds(
  listed: OpenMeterSubscriptionView[],
): string[] {
  return listed
    .filter(
      (s) => Boolean(s.id) && isScheduledSubscriptionStatus(s.status),
    )
    .map((s) => s.id);
}

export function isKonnectScheduledChangeForbidden(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /transition cancel in state scheduled not allowed|cancel in state scheduled/i.test(
    msg,
  );
}

/**
 * Clear scheduled successors so a subsequent `/change` or `/cancel` can succeed.
 * Konnect forbids `/cancel` on `scheduled` ("transition cancel in state
 * scheduled not allowed") — DELETE first. Fall back to immediate cancel only
 * if DELETE is rejected (row may have already become live).
 */
export async function clearScheduledSubscriptions(
  subscriptionIds: string[],
): Promise<void> {
  for (const subscriptionId of subscriptionIds) {
    try {
      await deleteKonnectSubscription({ subscriptionId });
      continue;
    } catch (deleteErr) {
      console.warn(
        "subscription-state: delete scheduled failed, trying cancel",
        subscriptionId,
        deleteErr instanceof Error ? deleteErr.message : deleteErr,
      );
    }
    try {
      await cancelKonnectSubscription({
        subscriptionId,
        timing: "immediate",
      });
    } catch (cancelErr) {
      console.warn(
        "subscription-state: cancel scheduled failed",
        subscriptionId,
        cancelErr instanceof Error ? cancelErr.message : cancelErr,
      );
    }
  }
}

/**
 * When Paid is canceled with a scheduled successor and there is no live row,
 * restore Paid (metering/v1) which also deletes the successor. Otherwise fall
 * back to clearScheduled. Pass `canceledPaidId` only when no live subscription
 * exists — restoring while a live row is active is incorrect.
 */
export async function clearScheduledBeforeMutation(input: {
  scheduledIds: string[];
  canceledPaidId?: string | null;
}): Promise<void> {
  if (input.canceledPaidId) {
    try {
      await restoreKonnectSubscription({
        subscriptionId: input.canceledPaidId,
      });
      return;
    } catch (restoreErr) {
      console.warn(
        "subscription-state: restore canceled Paid failed",
        restoreErr instanceof Error ? restoreErr.message : restoreErr,
      );
    }
  }
  await clearScheduledSubscriptions(input.scheduledIds);
}

export type ResumeTarget = {
  target: OpenMeterSubscriptionView;
  scheduledStarter: OpenMeterSubscriptionView | undefined;
  livePaid: OpenMeterSubscriptionView | undefined;
};

/**
 * Resolve which subscription to unschedule/restore for a pending cancel.
 * Prefer canceled paid; else live paid + scheduled starter (legacy change path).
 */
export function resolveResumeTarget(
  listed: OpenMeterSubscriptionView[],
  isStarter: StarterMatcher,
): ResumeTarget | null {
  const { livePaid, canceledPaid, scheduledStarter } = classifySubscriptions(
    listed,
    isStarter,
  );

  const target =
    canceledPaid ?? (livePaid && scheduledStarter ? livePaid : undefined);
  if (!target) return null;
  return { target, scheduledStarter, livePaid };
}

/**
 * Prefer live paid, then live starter, then any live row.
 * Scheduled rows are never mutation targets — callers must clear them first.
 */
export function pickMutationTargetSubscription(
  listed: OpenMeterSubscriptionView[],
  isStarter: StarterMatcher,
): OpenMeterSubscriptionView | null {
  const { livePaid, liveStarter } = classifySubscriptions(listed, isStarter);
  if (livePaid) return livePaid;
  if (liveStarter) return liveStarter;
  return pickLiveSubscription(listed);
}
