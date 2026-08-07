import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { getOrCreateStarterPlan } from "@/lib/starter-default-plan";
import { planDisplayNameWithStarter } from "@/lib/starter-default-plan-display";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { ensureOpenMeterCustomerForAppUser } from "./customers";
import {
  cancelKonnectSubscription,
  deleteKonnectSubscription,
  estimateNextBillingCycleIso,
  konnectSubscriptionBillingAnchorIso,
  restoreKonnectSubscription,
  unscheduleKonnectSubscriptionCancelation,
} from "./konnect-subscriptions";
import { buildOpenMeterPlanKey } from "./plan-naming";
import { isOwnerStarterPlanKey } from "./owner-starter-key";
import {
  listOpenMeterSubscriptionsForCustomer,
  resolveLocalPlanIdFromOpenMeterSubscription,
  type OpenMeterSubscriptionView,
} from "./subscription-read";
import {
  classifySubscriptions,
  clearScheduledBeforeMutation,
  isCanceledSubscriptionStatus,
  isKonnectScheduledChangeForbidden,
  isLiveSubscriptionStatus,
  pickOccupyingCanceledSubscription,
  resolveResumeTarget,
  type StarterMatcher,
} from "./subscription-state";

export type AppUserSubscriptionCancelErrorCode =
  | "confirm_required"
  | "openmeter_unavailable"
  | "no_subscription"
  | "already_starter"
  | "already_scheduled"
  | "cancel_failed";

export class AppUserSubscriptionCancelError extends Error {
  readonly code: AppUserSubscriptionCancelErrorCode;

  constructor(
    code: AppUserSubscriptionCancelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppUserSubscriptionCancelError";
    this.code = code;
  }
}

export type AppUserSubscriptionCancelResult = {
  subscriptionId: string;
  planId: string | null;
  planKey: string | null;
  scheduledPlanKey: string | null;
  effectiveAt: string | null;
  alreadyStarter?: boolean;
  alreadyScheduled?: boolean;
};

export type AppUserSubscriptionResumeErrorCode =
  | "confirm_required"
  | "openmeter_unavailable"
  | "nothing_to_resume"
  | "resume_failed";

export class AppUserSubscriptionResumeError extends Error {
  readonly code: AppUserSubscriptionResumeErrorCode;

  constructor(
    code: AppUserSubscriptionResumeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppUserSubscriptionResumeError";
    this.code = code;
  }
}

export type AppUserSubscriptionResumeResult = {
  resumed: true;
  subscriptionId: string;
  planId: string | null;
  planKey: string | null;
};

export type AppUserPendingCancel = {
  subscriptionId: string;
  planId: string | null;
  planKey: string | null;
  planName: string | null;
  effectiveAt: string | null;
};

function assertConfirm(
  confirm: boolean | undefined,
  message: string,
  ErrorClass:
    | typeof AppUserSubscriptionCancelError
    | typeof AppUserSubscriptionResumeError,
  code: "confirm_required",
): void {
  if (confirm !== true) {
    throw new ErrorClass(code, message);
  }
}

/** @deprecated Use isLiveSubscriptionStatus — scheduled is NOT live. */
export function isAppUserLiveSubscriptionStatus(status: string): boolean {
  return isLiveSubscriptionStatus(status);
}

export function isAppUserCanceledSubscriptionStatus(status: string): boolean {
  return isCanceledSubscriptionStatus(status);
}

export function isAppUserStarterSubscription(
  sub: OpenMeterSubscriptionView,
  starterPlanKey: string,
  starterOpenMeterPlanId: string | null,
): boolean {
  if (isOwnerStarterPlanKey(sub.planKey)) return true;
  if (sub.planKey && sub.planKey === starterPlanKey) return true;
  if (starterOpenMeterPlanId && sub.planId === starterOpenMeterPlanId) {
    return true;
  }
  return false;
}

function appUserStarterMatcher(
  starterPlanKey: string,
  starterOpenMeterPlanId: string | null,
): StarterMatcher {
  return (sub) =>
    isAppUserStarterSubscription(sub, starterPlanKey, starterOpenMeterPlanId);
}

export type AppUserCancelTargets = {
  livePaid: OpenMeterSubscriptionView | undefined;
  scheduledPaid: OpenMeterSubscriptionView | undefined;
  canceledPaid: OpenMeterSubscriptionView | undefined;
  liveStarter: OpenMeterSubscriptionView | undefined;
  scheduledStarter: OpenMeterSubscriptionView | undefined;
  scheduledIds: string[];
};

/** Classify listed OM subscriptions for cancel / pending-cancel decisions. */
export function pickAppUserCancelTargets(
  listed: OpenMeterSubscriptionView[],
  starterPlanKey: string,
  starterOpenMeterPlanId: string | null,
): AppUserCancelTargets {
  return classifySubscriptions(
    listed,
    appUserStarterMatcher(starterPlanKey, starterOpenMeterPlanId),
  );
}

/** Resolve which subscription to unschedule/restore for a pending cancel. */
export function resolveAppUserResumeTarget(
  listed: OpenMeterSubscriptionView[],
  starterPlanKey: string,
  starterOpenMeterPlanId: string | null,
): {
  target: OpenMeterSubscriptionView;
  scheduledStarter: OpenMeterSubscriptionView | undefined;
  livePaid: OpenMeterSubscriptionView | undefined;
} | null {
  return resolveResumeTarget(
    listed,
    appUserStarterMatcher(starterPlanKey, starterOpenMeterPlanId),
  );
}

/** Sync pending-cancel view from an already-listed subscription set. */
export function deriveAppUserPendingCancel(input: {
  listed: OpenMeterSubscriptionView[];
  starterPlanKey: string;
  starterOpenMeterPlanId: string | null;
  planId: string | null;
  planName: string | null;
}): AppUserPendingCancel | null {
  const { canceledPaid } = pickAppUserCancelTargets(
    input.listed,
    input.starterPlanKey,
    input.starterOpenMeterPlanId,
  );
  // Prefer canceled paid; else any cancel-at-period-end row (incl. Starter)
  // that still occupies the customer until activeTo.
  const pending =
    canceledPaid ??
    pickOccupyingCanceledSubscription(input.listed);
  if (!pending) return null;
  return {
    subscriptionId: pending.id,
    planId: input.planId,
    planKey: pending.planKey,
    planName: input.planName,
    effectiveAt: pending.activeTo,
  };
}

async function loadStarterKeys(clientId: string): Promise<{
  starterPlanKey: string;
  starterOpenMeterPlanId: string | null;
  starterLocalPlanId: string;
}> {
  const starter = await getOrCreateStarterPlan(clientId);
  return {
    starterPlanKey: buildOpenMeterPlanKey(clientId, starter.id),
    starterOpenMeterPlanId: starter.openmeterPlanId?.trim() || null,
    starterLocalPlanId: starter.id,
  };
}

/** DELETE a not-yet-started paid plan (Konnect forbids /cancel on `scheduled`). */
async function cancelScheduledOnlyPaid(input: {
  clientId: string;
  scheduledPaid: OpenMeterSubscriptionView;
}): Promise<AppUserSubscriptionCancelResult> {
  try {
    await deleteKonnectSubscription({ subscriptionId: input.scheduledPaid.id });
  } catch (err) {
    console.error("App-user scheduled subscription delete failed", err);
    throw new AppUserSubscriptionCancelError(
      "cancel_failed",
      "Could not cancel the scheduled subscription",
    );
  }
  const planId = await resolveLocalPlanIdFromOpenMeterSubscription(
    input.clientId,
    input.scheduledPaid,
  );
  return {
    subscriptionId: input.scheduledPaid.id,
    planId,
    planKey: input.scheduledPaid.planKey,
    scheduledPlanKey: null,
    effectiveAt: input.scheduledPaid.activeFrom ?? new Date().toISOString(),
  };
}

/**
 * Early exits when there is no live paid plan: already on Starter, cancel
 * already scheduled, or nothing to cancel.
 */
async function cancelWhenNoLivePaid(input: {
  clientId: string;
  liveStarter: OpenMeterSubscriptionView | undefined;
  canceledPaid: OpenMeterSubscriptionView | undefined;
  starterLocalPlanId: string;
  starterPlanKey: string;
}): Promise<AppUserSubscriptionCancelResult> {
  if (input.liveStarter) {
    return {
      subscriptionId: input.liveStarter.id,
      planId: input.starterLocalPlanId,
      planKey: input.liveStarter.planKey,
      scheduledPlanKey: input.liveStarter.planKey,
      effectiveAt: null,
      alreadyStarter: true,
    };
  }
  if (input.canceledPaid) {
    const planId = await resolveLocalPlanIdFromOpenMeterSubscription(
      input.clientId,
      input.canceledPaid,
    );
    return {
      subscriptionId: input.canceledPaid.id,
      planId,
      planKey: input.canceledPaid.planKey,
      scheduledPlanKey: input.starterPlanKey,
      effectiveAt: input.canceledPaid.activeTo,
      alreadyScheduled: true,
    };
  }
  throw new AppUserSubscriptionCancelError(
    "no_subscription",
    "No active subscription to cancel",
  );
}

async function assertLivePaidCancelable(input: {
  clientId: string;
  livePaid: OpenMeterSubscriptionView;
  starterPlanKey: string;
  starterOpenMeterPlanId: string | null;
}): Promise<string | null> {
  if (
    isAppUserStarterSubscription(
      input.livePaid,
      input.starterPlanKey,
      input.starterOpenMeterPlanId,
    )
  ) {
    throw new AppUserSubscriptionCancelError(
      "already_starter",
      "Starter plans cannot be canceled",
    );
  }
  const localPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    input.clientId,
    input.livePaid,
  );
  if (!localPlanId) {
    return null;
  }
  const rows = await db
    .select({ isStarterDefault: plans.isStarterDefault })
    .from(plans)
    .where(and(eq(plans.id, localPlanId), eq(plans.clientId, input.clientId)))
    .limit(1);
  if (rows[0]?.isStarterDefault) {
    throw new AppUserSubscriptionCancelError(
      "already_starter",
      "Starter plans cannot be canceled",
    );
  }
  return localPlanId;
}

async function scheduleLivePaidCancel(input: {
  livePaid: OpenMeterSubscriptionView;
  localPlanId: string | null;
  starterPlanKey: string;
}): Promise<AppUserSubscriptionCancelResult> {
  let canceled;
  try {
    canceled = await cancelKonnectSubscription({
      subscriptionId: input.livePaid.id,
      timing: "next_billing_cycle",
    });
  } catch (err) {
    if (isKonnectScheduledChangeForbidden(err)) {
      throw new AppUserSubscriptionCancelError(
        "cancel_failed",
        "A scheduled plan change is blocking cancellation. Try again or contact support.",
      );
    }
    console.error("App-user subscription cancel failed", err);
    throw new AppUserSubscriptionCancelError(
      "cancel_failed",
      "Could not schedule subscription cancellation",
    );
  }

  const effectiveAt =
    input.livePaid.activeTo ||
    estimateNextBillingCycleIso(konnectSubscriptionBillingAnchorIso(canceled));

  return {
    subscriptionId: canceled.id?.trim() || input.livePaid.id,
    planId: input.localPlanId,
    planKey: input.livePaid.planKey,
    scheduledPlanKey: input.starterPlanKey,
    effectiveAt,
  };
}

/**
 * Schedule end-of-cycle cancel for the app user's paid (non-Starter) plan.
 * Mirrors owner `downgradeOwnerToStarterPlan`: Konnect cancel with
 * `next_billing_cycle`; Starter is provisioned lazily when Paid ends.
 */
export async function cancelAppUserSubscription(input: {
  clientId: string;
  externalUserId: string;
  confirm?: boolean;
}): Promise<AppUserSubscriptionCancelResult> {
  assertConfirm(
    input.confirm,
    "Confirm to cancel at the end of this billing cycle",
    AppUserSubscriptionCancelError,
    "confirm_required",
  );

  if (!isHostedAdminClientAvailable()) {
    throw new AppUserSubscriptionCancelError(
      "openmeter_unavailable",
      "OpenMeter is not configured",
    );
  }

  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    throw new AppUserSubscriptionCancelError(
      "cancel_failed",
      "clientId and externalUserId are required",
    );
  }

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId,
    externalUserId,
  });
  const { starterPlanKey, starterOpenMeterPlanId, starterLocalPlanId } =
    await loadStarterKeys(clientId);

  const listed = await listOpenMeterSubscriptionsForCustomer(client, customer.id);
  let { livePaid, scheduledPaid, canceledPaid, liveStarter, scheduledIds } =
    pickAppUserCancelTargets(listed, starterPlanKey, starterOpenMeterPlanId);

  if (!livePaid && scheduledPaid) {
    return cancelScheduledOnlyPaid({ clientId, scheduledPaid });
  }

  // Scheduled successors block cancel on a live paid plan. Clear them first.
  if (livePaid && scheduledIds.length > 0) {
    await clearScheduledBeforeMutation({
      scheduledIds,
      canceledPaidId: null,
    });
    const refreshed = await listOpenMeterSubscriptionsForCustomer(
      client,
      customer.id,
    );
    ({ livePaid, canceledPaid, liveStarter } = pickAppUserCancelTargets(
      refreshed,
      starterPlanKey,
      starterOpenMeterPlanId,
    ));
  }

  if (!livePaid) {
    return cancelWhenNoLivePaid({
      clientId,
      liveStarter,
      canceledPaid,
      starterLocalPlanId,
      starterPlanKey,
    });
  }

  const localPlanId = await assertLivePaidCancelable({
    clientId,
    livePaid,
    starterPlanKey,
    starterOpenMeterPlanId,
  });
  return scheduleLivePaidCancel({
    livePaid,
    localPlanId,
    starterPlanKey,
  });
}

export function appUserSubscriptionCancelHttpStatus(
  code: AppUserSubscriptionCancelErrorCode,
): number {
  switch (code) {
    case "openmeter_unavailable":
      return 503;
    case "no_subscription":
    case "already_starter":
      return 404;
    case "confirm_required":
    case "already_scheduled":
      return 400;
    default:
      return 502;
  }
}

/**
 * Undo a pending end-of-cycle cancel (mirror owner resume).
 */
export async function resumeAppUserSubscription(input: {
  clientId: string;
  externalUserId: string;
  confirm?: boolean;
}): Promise<AppUserSubscriptionResumeResult> {
  assertConfirm(
    input.confirm,
    "Confirm to keep your plan and cancel the scheduled cancellation",
    AppUserSubscriptionResumeError,
    "confirm_required",
  );

  if (!isHostedAdminClientAvailable()) {
    throw new AppUserSubscriptionResumeError(
      "openmeter_unavailable",
      "OpenMeter is not configured",
    );
  }

  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    throw new AppUserSubscriptionResumeError(
      "resume_failed",
      "clientId and externalUserId are required",
    );
  }

  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId,
    externalUserId,
  });
  const { starterPlanKey, starterOpenMeterPlanId } = await loadStarterKeys(clientId);
  const listed = await listOpenMeterSubscriptionsForCustomer(client, customer.id);

  const resume = resolveAppUserResumeTarget(
    listed,
    starterPlanKey,
    starterOpenMeterPlanId,
  );
  if (!resume) {
    throw new AppUserSubscriptionResumeError(
      "nothing_to_resume",
      "No scheduled cancellation to undo",
    );
  }
  const { target, scheduledStarter, livePaid } = resume;

  try {
    if (scheduledStarter?.id && livePaid?.id === target.id) {
      const restored = await restoreKonnectSubscription({
        subscriptionId: target.id,
      });
      const planId = await resolveLocalPlanIdFromOpenMeterSubscription(
        clientId,
        target,
      );
      return {
        resumed: true,
        subscriptionId: restored.id?.trim() || target.id,
        planId,
        planKey: target.planKey,
      };
    }

    const resumed = await unscheduleKonnectSubscriptionCancelation({
      subscriptionId: target.id,
    });
    const planId = await resolveLocalPlanIdFromOpenMeterSubscription(
      clientId,
      target,
    );
    return {
      resumed: true,
      subscriptionId: resumed.id?.trim() || target.id,
      planId,
      planKey: target.planKey,
    };
  } catch (err) {
    if (err instanceof AppUserSubscriptionResumeError) throw err;
    console.error("App-user subscription resume failed", err);
    throw new AppUserSubscriptionResumeError(
      "resume_failed",
      "Could not cancel the scheduled cancellation",
    );
  }
}

export function appUserSubscriptionResumeHttpStatus(
  code: AppUserSubscriptionResumeErrorCode,
): number {
  switch (code) {
    case "openmeter_unavailable":
      return 503;
    case "nothing_to_resume":
      return 404;
    case "confirm_required":
      return 400;
    default:
      return 502;
  }
}

/** Derive pending end-of-cycle cancel for GET subscription responses. */
export async function resolveAppUserPendingCancel(input: {
  clientId: string;
  listed: OpenMeterSubscriptionView[];
}): Promise<AppUserPendingCancel | null> {
  const { starterPlanKey, starterOpenMeterPlanId, starterLocalPlanId } =
    await loadStarterKeys(input.clientId);

  // Prefer canceled paid; else cancel-at-period-end Starter (or any occupying
  // canceled row). Both still own the customer slot until `activeTo`.
  const { canceledPaid } = pickAppUserCancelTargets(
    input.listed,
    starterPlanKey,
    starterOpenMeterPlanId,
  );
  const pendingRow =
    canceledPaid ?? pickOccupyingCanceledSubscription(input.listed);
  if (!pendingRow) {
    return null;
  }

  const planId =
    (await resolveLocalPlanIdFromOpenMeterSubscription(
      input.clientId,
      pendingRow,
    )) ??
    (isAppUserStarterSubscription(
      pendingRow,
      starterPlanKey,
      starterOpenMeterPlanId,
    )
      ? starterLocalPlanId
      : null);

  let planName: string | null = null;
  if (planId) {
    const rows = await db
      .select({
        name: plans.name,
        isStarterDefault: plans.isStarterDefault,
        isNetworkDefault: plans.isNetworkDefault,
      })
      .from(plans)
      .where(eq(plans.id, planId))
      .limit(1);
    if (rows[0]) {
      planName = planDisplayNameWithStarter(rows[0]);
    }
  }

  return deriveAppUserPendingCancel({
    listed: input.listed,
    starterPlanKey,
    starterOpenMeterPlanId,
    planId,
    planName,
  });
}
