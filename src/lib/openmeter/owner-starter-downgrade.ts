import { resolveOwnerStarterIncludedUsdMicros } from "@/lib/billing/owner-billing-config";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { ensureOwnerCustomer, listOwnedPublicClientIds } from "./customers";
import { changeKonnectSubscription, restoreKonnectSubscription } from "./konnect-subscriptions";
import { isOwnerPaidPlanKey } from "./owner-paid-key";
import {
  ensureOwnerStarterPlanSynced,
  isOwnerStarterPlanKey,
} from "./owner-starter-plan";
import { isOpenMeterPlanNotFoundError } from "./plan-errors";
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

function pickWalletSubs(
  listed: OpenMeterSubscriptionView[],
): {
  activePaid: OpenMeterSubscriptionView | null;
  activeStarter: OpenMeterSubscriptionView | null;
  scheduledStarter: OpenMeterSubscriptionView | null;
} {
  let activePaid: OpenMeterSubscriptionView | null = null;
  let activeStarter: OpenMeterSubscriptionView | null = null;
  let scheduledStarter: OpenMeterSubscriptionView | null = null;

  for (const sub of listed) {
    const status = (sub.status || "").toLowerCase();
    const isLive = status === "active" || status === "trialing" || !status;
    const isScheduled = status === "scheduled" || status === "pending";

    if (isLive && isOwnerPaidPlanKey(sub.planKey) && !activePaid) {
      activePaid = sub;
    }
    if (isLive && isOwnerStarterPlanKey(sub.planKey) && !activeStarter) {
      activeStarter = sub;
    }
    if (isScheduled && isOwnerStarterPlanKey(sub.planKey) && !scheduledStarter) {
      scheduledStarter = sub;
    }
  }

  return { activePaid, activeStarter, scheduledStarter };
}

/**
 * Schedule Sandbox Starter for the owner wallet at `next_billing_cycle`.
 * Current Owner Paid plan stays active until then. Does **not** apply the free
 * billing profile — that runs lazily once Starter is the active plan.
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

  const includedUsdMicros =
    await resolveOwnerStarterIncludedUsdMicros(ownerUserId);
  const starter = await ensureOwnerStarterPlanSynced(includedUsdMicros);

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
  const { activePaid, activeStarter, scheduledStarter } = pickWalletSubs(listed);

  if (activeStarter?.id && !activePaid) {
    return {
      openmeterSubscriptionId: activeStarter.id,
      planKey: activeStarter.planKey || starter.key,
      scheduledPlanKey: starter.key,
      openmeterPlanId: activeStarter.planId || starter.openmeterPlanId,
      effectiveAt: null,
      alreadyStarter: true,
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
      scheduledPlanKey: scheduledStarter.planKey || starter.key,
      openmeterPlanId: starter.openmeterPlanId,
      effectiveAt: scheduledStarter.activeFrom ?? activePaid.activeTo ?? null,
      alreadyScheduled: true,
    };
  }

  return changePaidSubscriptionToStarterNextCycle({
    subscriptionId: activePaid.id,
    customerId: customer.id,
    currentPlanKey: activePaid.planKey || "",
    currentActiveTo: activePaid.activeTo,
    starter,
  });
}

async function changePaidSubscriptionToStarterNextCycle(input: {
  subscriptionId: string;
  customerId: string;
  currentPlanKey: string;
  currentActiveTo: string | null;
  starter: { key: string; openmeterPlanId: string };
}): Promise<OwnerStarterDowngradeResult> {
  let openmeterPlanId = input.starter.openmeterPlanId;
  let scheduledPlanKey = input.starter.key;
  let change;

  try {
    change = await changeKonnectSubscription({
      subscriptionId: input.subscriptionId,
      customerId: input.customerId,
      planId: openmeterPlanId,
      timing: "next_billing_cycle",
    });
  } catch (err) {
    if (!isOpenMeterPlanNotFoundError(err)) {
      console.error("Owner Starter downgrade failed", err);
      throw new OwnerStarterDowngradeError(
        "downgrade_failed",
        "Could not schedule Sandbox Starter",
      );
    }
    const resynced = await ensureOwnerStarterPlanSynced();
    openmeterPlanId = resynced.openmeterPlanId;
    scheduledPlanKey = resynced.key;
    try {
      change = await changeKonnectSubscription({
        subscriptionId: input.subscriptionId,
        customerId: input.customerId,
        planId: openmeterPlanId,
        timing: "next_billing_cycle",
      });
    } catch (retryErr) {
      console.error("Owner Starter downgrade retry failed", retryErr);
      throw new OwnerStarterDowngradeError(
        "downgrade_failed",
        "Could not schedule Sandbox Starter",
      );
    }
  }

  const nextId =
    change.next?.id?.trim() ||
    change.current?.id?.trim() ||
    input.subscriptionId;

  // Prefer the scheduled next's start; fall back to current activeTo (cycle end).
  const effectiveAt = input.currentActiveTo;

  return {
    openmeterSubscriptionId: nextId,
    planKey: input.currentPlanKey,
    scheduledPlanKey,
    openmeterPlanId,
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

/** Paid sub to restore when a Starter downgrade is scheduled; null if none. */
export function resolveOwnerPaidResumeTarget(
  listed: OpenMeterSubscriptionView[],
): { subscriptionId: string; planKey: string } | null {
  const { activePaid, scheduledStarter } = pickWalletSubs(listed);
  if (!activePaid?.id || !scheduledStarter?.id) {
    return null;
  }
  return {
    subscriptionId: activePaid.id,
    planKey: activePaid.planKey || "",
  };
}

/**
 * Cancel a scheduled end-of-cycle Starter downgrade by restoring the active
 * Owner Paid subscription (OpenMeter deletes the scheduled successor).
 * No charge — the current paid plan continues.
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
    const restored = await restoreKonnectSubscription({
      subscriptionId: target.subscriptionId,
    });
    return {
      resumed: true,
      openmeterSubscriptionId: restored.id?.trim() || target.subscriptionId,
      planKey: target.planKey,
      planName: null,
    };
  } catch (err) {
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
};

function isLiveSubscriptionStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "active" || s === "trialing" || !s;
}

function isScheduledSubscriptionStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "scheduled" || s === "pending";
}

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
 * surface it as a pending end-of-cycle downgrade.
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
  const paid = wallet.find(
    (row) =>
      isOwnerPaidPlanKey(row.openMeterPlanKey) &&
      isLiveSubscriptionStatus(row.status),
  );
  const scheduledStarter = wallet.find(
    (row) =>
      isOwnerStarterPlanKey(row.openMeterPlanKey) &&
      isScheduledSubscriptionStatus(row.status),
  );

  const pendingDowngrade =
    paid && scheduledStarter && scheduledStarter.openMeterPlanKey
      ? {
          planName: input.starterPlanName,
          planKey: scheduledStarter.openMeterPlanKey,
          effectiveAt:
            scheduledStarter.activeFrom ?? paid.activeTo ?? null,
          currentPlanName: paid.planName,
        }
      : null;

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
