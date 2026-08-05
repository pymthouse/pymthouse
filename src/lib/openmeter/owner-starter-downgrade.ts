import { resolveOwnerStarterIncludedUsdMicros } from "@/lib/billing/owner-billing-config";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { ensureOwnerCustomer, listOwnedPublicClientIds } from "./customers";
import {
  cancelKonnectSubscription,
  deleteKonnectSubscription,
  estimateNextBillingCycleIso,
  konnectSubscriptionBillingAnchorIso,
  restoreKonnectSubscription,
  unscheduleKonnectSubscriptionCancelation,
} from "./konnect-subscriptions";
import { isOwnerPaidPlanKey } from "./owner-paid-key";
import {
  ensureOwnerStarterPlanSynced,
  isOwnerStarterPlanKey,
} from "./owner-starter-plan";
import {
  listOpenMeterSubscriptionsForCustomer,
  type OpenMeterSubscriptionView,
} from "./subscription-read";

export type OwnerStarterDowngradeErrorCode =
  | "confirm_required"
  | "openmeter_unavailable"
  | "no_subscription"
  | "not_on_paid"
  | "downgrade_failed";

export class OwnerStarterDowngradeError extends Error {
  readonly code: OwnerStarterDowngradeErrorCode;

  constructor(
    code: OwnerStarterDowngradeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OwnerStarterDowngradeError";
    this.code = code;
  }
}

export type OwnerStarterDowngradeResult = {
  openmeterSubscriptionId: string;
  /** Plan key that remains active until the cycle ends (Paid). */
  planKey: string;
  /** Starter plan key scheduled to take over. */
  scheduledPlanKey: string;
  openmeterPlanId: string;
  /** ISO timestamp when Starter is expected to start, when Konnect provides it. */
  effectiveAt: string | null;
  alreadyStarter?: boolean;
  alreadyScheduled?: boolean;
};

function assertDowngradeConfirm(confirm: boolean | undefined): void {
  if (confirm !== true) {
    throw new OwnerStarterDowngradeError(
      "confirm_required",
      "Confirm to schedule Sandbox Starter at the end of this billing cycle",
    );
  }
}

function isLiveSubscriptionStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "active" || s === "trialing" || !s;
}

function isScheduledSubscriptionStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "scheduled" || s === "pending";
}

function isCanceledSubscriptionStatus(status: string): boolean {
  return status.toLowerCase() === "canceled";
}

function pickWalletSubs(
  listed: OpenMeterSubscriptionView[],
): {
  activePaid: OpenMeterSubscriptionView | null;
  canceledPaid: OpenMeterSubscriptionView | null;
  activeStarter: OpenMeterSubscriptionView | null;
  scheduledStarter: OpenMeterSubscriptionView | null;
} {
  let activePaid: OpenMeterSubscriptionView | null = null;
  let canceledPaid: OpenMeterSubscriptionView | null = null;
  let activeStarter: OpenMeterSubscriptionView | null = null;
  let scheduledStarter: OpenMeterSubscriptionView | null = null;

  for (const sub of listed) {
    const status = sub.status || "";
    const isLive = isLiveSubscriptionStatus(status);
    const isScheduled = isScheduledSubscriptionStatus(status);
    const isCanceled = isCanceledSubscriptionStatus(status);

    if (isLive && isOwnerPaidPlanKey(sub.planKey) && !activePaid) {
      activePaid = sub;
    }
    if (isCanceled && isOwnerPaidPlanKey(sub.planKey) && !canceledPaid) {
      canceledPaid = sub;
    }
    if (isLive && isOwnerStarterPlanKey(sub.planKey) && !activeStarter) {
      activeStarter = sub;
    }
    if (isScheduled && isOwnerStarterPlanKey(sub.planKey) && !scheduledStarter) {
      scheduledStarter = sub;
    }
  }

  return { activePaid, canceledPaid, activeStarter, scheduledStarter };
}

/**
 * Schedule end-of-cycle cancel of Owner Paid (Konnect `cancel` +
 * `next_billing_cycle`). Sandbox Starter is created lazily once Paid ends —
 * do **not** `/change` onto Starter (Konnect cannot delete scheduled
 * successors, which blocks resume/re-upgrade).
 */
export async function downgradeOwnerToStarterPlan(input: {
  ownerUserId: string;
  confirm?: boolean;
}): Promise<OwnerStarterDowngradeResult> {
  assertDowngradeConfirm(input.confirm);

  if (!isHostedAdminClientAvailable()) {
    throw new OwnerStarterDowngradeError(
      "openmeter_unavailable",
      "OpenMeter is not configured",
    );
  }

  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new OwnerStarterDowngradeError(
      "downgrade_failed",
      "ownerUserId is required",
    );
  }

  const client = getHostedAdminClient();
  const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
  const customer = await ensureOwnerCustomer(
    client,
    ownerUserId,
    publicClientIds,
  );

  const listed = await listOpenMeterSubscriptionsForCustomer(
    client,
    customer.id,
  );
  const { activePaid, canceledPaid, activeStarter, scheduledStarter } =
    pickWalletSubs(listed);

  if (activeStarter?.id && !activePaid && !canceledPaid) {
    return {
      openmeterSubscriptionId: activeStarter.id,
      planKey: activeStarter.planKey || "",
      scheduledPlanKey: activeStarter.planKey || "",
      openmeterPlanId: activeStarter.planId || "",
      effectiveAt: null,
      alreadyStarter: true,
    };
  }

  // Already cancel-at-period-end (or legacy change-based with canceled Paid).
  if (canceledPaid?.id && !activePaid) {
    const includedUsdMicros =
      await resolveOwnerStarterIncludedUsdMicros(ownerUserId);
    const starter = await ensureOwnerStarterPlanSynced(includedUsdMicros);
    return {
      openmeterSubscriptionId: canceledPaid.id,
      planKey: canceledPaid.planKey || "",
      scheduledPlanKey: scheduledStarter?.planKey || starter.key,
      openmeterPlanId: scheduledStarter?.planId || starter.openmeterPlanId,
      effectiveAt:
        scheduledStarter?.activeFrom ??
        canceledPaid.activeTo ??
        null,
      alreadyScheduled: true,
    };
  }

  if (!activePaid?.id) {
    throw new OwnerStarterDowngradeError(
      "not_on_paid",
      "Downgrade is only available on an Owner Paid plan",
    );
  }

  if (scheduledStarter?.id) {
    return {
      openmeterSubscriptionId: activePaid.id,
      planKey: activePaid.planKey || "",
      scheduledPlanKey: scheduledStarter.planKey || "",
      openmeterPlanId: scheduledStarter.planId || "",
      effectiveAt: scheduledStarter.activeFrom ?? activePaid.activeTo ?? null,
      alreadyScheduled: true,
    };
  }

  const includedUsdMicros =
    await resolveOwnerStarterIncludedUsdMicros(ownerUserId);
  const starter = await ensureOwnerStarterPlanSynced(includedUsdMicros);

  return cancelPaidSubscriptionAtNextCycle({
    subscriptionId: activePaid.id,
    currentPlanKey: activePaid.planKey || "",
    currentActiveTo: activePaid.activeTo,
    starter,
  });
}

async function cancelPaidSubscriptionAtNextCycle(input: {
  subscriptionId: string;
  currentPlanKey: string;
  currentActiveTo: string | null;
  starter: { key: string; openmeterPlanId: string; includedUsdMicros: string };
}): Promise<OwnerStarterDowngradeResult> {
  let canceled;
  try {
    canceled = await cancelKonnectSubscription({
      subscriptionId: input.subscriptionId,
      timing: "next_billing_cycle",
    });
  } catch (err) {
    console.error("Owner Starter downgrade failed", err);
    throw new OwnerStarterDowngradeError(
      "downgrade_failed",
      "Could not schedule Sandbox Starter",
    );
  }

  const effectiveAt =
    input.currentActiveTo ||
    estimateNextBillingCycleIso(konnectSubscriptionBillingAnchorIso(canceled));

  return {
    openmeterSubscriptionId: canceled.id?.trim() || input.subscriptionId,
    planKey: input.currentPlanKey,
    scheduledPlanKey: input.starter.key,
    openmeterPlanId: input.starter.openmeterPlanId,
    effectiveAt,
    alreadyScheduled: false,
  };
}

/** Map downgrade error codes to HTTP status. */
export function ownerStarterDowngradeHttpStatus(
  code: OwnerStarterDowngradeErrorCode,
): number {
  switch (code) {
    case "openmeter_unavailable":
      return 503;
    case "no_subscription":
    case "not_on_paid":
      return 404;
    case "confirm_required":
      return 400;
    default:
      return 502;
  }
}

export type OwnerPaidResumeErrorCode =
  | "confirm_required"
  | "openmeter_unavailable"
  | "nothing_to_resume"
  | "resume_failed";

export class OwnerPaidResumeError extends Error {
  readonly code: OwnerPaidResumeErrorCode;

  constructor(
    code: OwnerPaidResumeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OwnerPaidResumeError";
    this.code = code;
  }
}

export type OwnerPaidResumeResult = {
  resumed: true;
  openmeterSubscriptionId: string;
  planKey: string;
  planName: string | null;
};

/** Paid sub to unschedule/restore when a downgrade is pending; null if none. */
export function resolveOwnerPaidResumeTarget(
  listed: OpenMeterSubscriptionView[],
): {
  subscriptionId: string;
  planKey: string;
  scheduledStarterId: string | null;
} | null {
  const { activePaid, canceledPaid, scheduledStarter } = pickWalletSubs(listed);

  // Legacy change-based: live Paid + scheduled Starter successor.
  if (activePaid?.id && scheduledStarter?.id) {
    return {
      subscriptionId: activePaid.id,
      planKey: activePaid.planKey || "",
      scheduledStarterId: scheduledStarter.id,
    };
  }

  // Cancel-at-period-end, or change-based where Paid already shows canceled.
  if (canceledPaid?.id) {
    return {
      subscriptionId: canceledPaid.id,
      planKey: canceledPaid.planKey || "",
      scheduledStarterId: scheduledStarter?.id ?? null,
    };
  }

  return null;
}

/**
 * Undo a pending end-of-cycle downgrade.
 * Prefer Konnect `unschedule-cancelation` (cancel-at-period-end). When a legacy
 * scheduled Starter successor exists, try delete then unschedule, then restore.
 */
export async function resumeOwnerPaidAfterScheduledDowngrade(input: {
  ownerUserId: string;
  confirm?: boolean;
}): Promise<OwnerPaidResumeResult> {
  if (input.confirm !== true) {
    throw new OwnerPaidResumeError(
      "confirm_required",
      "Confirm to keep your paid plan and cancel the scheduled downgrade",
    );
  }

  if (!isHostedAdminClientAvailable()) {
    throw new OwnerPaidResumeError(
      "openmeter_unavailable",
      "OpenMeter is not configured",
    );
  }

  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) {
    throw new OwnerPaidResumeError(
      "resume_failed",
      "ownerUserId is required",
    );
  }

  const client = getHostedAdminClient();
  const publicClientIds = await listOwnedPublicClientIds(ownerUserId);
  const customer = await ensureOwnerCustomer(
    client,
    ownerUserId,
    publicClientIds,
  );

  const listed = await listOpenMeterSubscriptionsForCustomer(
    client,
    customer.id,
  );
  const target = resolveOwnerPaidResumeTarget(listed);

  if (!target) {
    throw new OwnerPaidResumeError(
      "nothing_to_resume",
      "No scheduled downgrade to cancel",
    );
  }

  try {
    if (target.scheduledStarterId) {
      try {
        await deleteKonnectSubscription({
          subscriptionId: target.scheduledStarterId,
        });
      } catch (deleteErr) {
        console.warn(
          "Owner Paid resume: delete scheduled Starter failed",
          deleteErr instanceof Error ? deleteErr.message : deleteErr,
        );
        try {
          await restoreKonnectSubscription({
            subscriptionId: target.subscriptionId,
          });
          return {
            resumed: true,
            openmeterSubscriptionId: target.subscriptionId,
            planKey: target.planKey,
            planName: null,
          };
        } catch (restoreErr) {
          console.warn(
            "Owner Paid resume: restore failed after scheduled delete miss",
            restoreErr instanceof Error ? restoreErr.message : restoreErr,
          );
          throw new OwnerPaidResumeError(
            "resume_failed",
            "Could not cancel the scheduled downgrade — email billing@pymthouse.com and we’ll unblock your account.",
          );
        }
      }
    }

    const resumed = await unscheduleKonnectSubscriptionCancelation({
      subscriptionId: target.subscriptionId,
    });
    return {
      resumed: true,
      openmeterSubscriptionId: resumed.id?.trim() || target.subscriptionId,
      planKey: target.planKey,
      planName: null,
    };
  } catch (err) {
    if (err instanceof OwnerPaidResumeError) {
      throw err;
    }
    console.error("Owner Paid resume failed", err);
    throw new OwnerPaidResumeError(
      "resume_failed",
      "Could not cancel the scheduled downgrade",
    );
  }
}

export function ownerPaidResumeHttpStatus(code: OwnerPaidResumeErrorCode): number {
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

export function pickOwnerWalletSubsForDowngrade(
  listed: OpenMeterSubscriptionView[],
) {
  return pickWalletSubs(listed);
}

export type OwnerPendingDowngrade = {
  planName: string;
  planKey: string;
  effectiveAt: string | null;
  currentPlanName: string | null;
  /**
   * True when a scheduled Starter successor exists. Konnect Metering cannot
   * delete/restore that successor via API — resume/re-upgrade need support.
   */
  resumeBlocked: boolean;
};

export type OwnerPendingDowngradeSubscriptionRow = {
  appPublicClientId?: string | null;
  openMeterPlanKey?: string | null;
  planName: string;
  status: string;
  activeFrom?: string | null;
  activeTo?: string | null;
};

/**
 * Split wallet billing rows: hide scheduled Starter from the plan card list and
 * surface cancel-at-period-end / legacy scheduled-Starter as pending downgrade.
 */
export function deriveOwnerPendingDowngrade<
  T extends OwnerPendingDowngradeSubscriptionRow,
>(input: {
  subscriptions: T[];
  starterPlanName: string;
}): {
  displaySubscriptions: T[];
  pendingDowngrade: OwnerPendingDowngrade | null;
} {
  const wallet = input.subscriptions.filter(
    (row) => row.appPublicClientId == null,
  );
  const livePaid = wallet.find(
    (row) =>
      isOwnerPaidPlanKey(row.openMeterPlanKey) &&
      isLiveSubscriptionStatus(row.status),
  );
  const canceledPaid = wallet.find(
    (row) =>
      isOwnerPaidPlanKey(row.openMeterPlanKey) &&
      isCanceledSubscriptionStatus(row.status),
  );
  const liveStarter = wallet.find(
    (row) =>
      isOwnerStarterPlanKey(row.openMeterPlanKey) &&
      isLiveSubscriptionStatus(row.status),
  );
  const scheduledStarter = wallet.find(
    (row) =>
      isOwnerStarterPlanKey(row.openMeterPlanKey) &&
      isScheduledSubscriptionStatus(row.status),
  );

  const paidForPending = livePaid ?? canceledPaid;
  let pendingDowngrade: OwnerPendingDowngrade | null = null;

  if (
    paidForPending &&
    scheduledStarter?.openMeterPlanKey &&
    (livePaid || canceledPaid)
  ) {
    pendingDowngrade = {
      planName: input.starterPlanName,
      planKey: scheduledStarter.openMeterPlanKey,
      effectiveAt:
        scheduledStarter.activeFrom ?? paidForPending.activeTo ?? null,
      currentPlanName: paidForPending.planName,
      resumeBlocked: true,
    };
  } else if (
    canceledPaid &&
    !livePaid &&
    !liveStarter &&
    !scheduledStarter
  ) {
    pendingDowngrade = {
      planName: input.starterPlanName,
      planKey: "pymthouse_owner_starter",
      effectiveAt: canceledPaid.activeTo ?? null,
      currentPlanName: canceledPaid.planName,
      resumeBlocked: false,
    };
  }

  if (!pendingDowngrade) {
    return {
      displaySubscriptions: input.subscriptions,
      pendingDowngrade: null,
    };
  }

  return {
    displaySubscriptions: input.subscriptions.filter((row) => {
      if (row.appPublicClientId != null) return true;
      return !(
        isOwnerStarterPlanKey(row.openMeterPlanKey) &&
        isScheduledSubscriptionStatus(row.status)
      );
    }),
    pendingDowngrade,
  };
}
