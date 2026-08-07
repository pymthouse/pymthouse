import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { authorizeAppForBilling } from "@/lib/billing/app-auth";
import {
  readConfirmFlag,
  readJsonObject,
} from "@/lib/billing/owner-billing-m2m-auth";
import { tryDecodeURIComponent } from "@/lib/billing-utils";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import {
  AppUserSubscriptionCancelError,
  appUserSubscriptionCancelHttpStatus,
  cancelAppUserSubscription,
  resolveAppUserPendingCancel,
} from "@/lib/openmeter/app-user-subscription-lifecycle";
import { ensureOpenMeterCustomerForAppUser } from "@/lib/openmeter/customers";
import {
  OWNER_STARTER_PLAN_NAME,
  isOwnerStarterPlanKey,
} from "@/lib/openmeter/owner-starter-key";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  listOpenMeterSubscriptionsForCustomer,
  resolveLocalPlanIdFromOpenMeterSubscription,
  type OpenMeterSubscriptionView,
} from "@/lib/openmeter/subscription-read";

async function resolveDisplaySubscription(input: {
  clientId: string;
  externalUserId: string;
  pendingCancel: Awaited<ReturnType<typeof resolveAppUserPendingCancel>>;
}): Promise<OpenMeterSubscriptionView | null> {
  const primary = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  if (primary) {
    return primary;
  }
  if (!input.pendingCancel || !isHostedAdminClientAvailable()) {
    return null;
  }
  const client = getHostedAdminClient();
  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const listed = await listOpenMeterSubscriptionsForCustomer(client, customer.id);
  return (
    listed.find((sub) => sub.id === input.pendingCancel?.subscriptionId) ?? null
  );
}

/**
 * GET /api/v1/apps/{clientId}/users/{externalUserId}/subscription
 *
 * Current OpenMeter subscription for an app end-user, including
 * `pendingCancel` when cancel-at-period-end is scheduled (owner-paid parity).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = tryDecodeURIComponent(raw)?.trim() ?? "";
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required" },
      { status: 400 },
    );
  }
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let pendingCancel: Awaited<ReturnType<typeof resolveAppUserPendingCancel>> =
    null;
  if (isHostedAdminClientAvailable()) {
    try {
      const client = getHostedAdminClient();
      const customer = await ensureOpenMeterCustomerForAppUser({
        client,
        clientId: access.app.id,
        externalUserId,
      });
      const listed = await listOpenMeterSubscriptionsForCustomer(
        client,
        customer.id,
      );
      pendingCancel = await resolveAppUserPendingCancel({
        clientId: access.app.id,
        listed,
      });
    } catch (err) {
      console.error("Failed to resolve pendingCancel for app user", err);
    }
  }

  const omSubscription = await resolveDisplaySubscription({
    clientId: access.app.id,
    externalUserId,
    pendingCancel,
  });

  if (!omSubscription) {
    return NextResponse.json({
      externalUserId,
      subscription: null,
      pendingCancel: null,
      source: "openmeter",
    });
  }

  const resolvedPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    access.app.id,
    omSubscription,
  );
  const planRows = resolvedPlanId
    ? await db.select().from(plans).where(eq(plans.id, resolvedPlanId)).limit(1)
    : [];
  const plan = planRows[0] ?? null;
  const isOwnerStarter = isOwnerStarterPlanKey(omSubscription.planKey);

  const planStatus = plan?.status ?? null;
  const actionRequired =
    (!plan && !isOwnerStarter) || planStatus === "phase_out"
      ? "choose_new_plan"
      : null;

  let planPayload: {
    id: string | null;
    status: string;
    phaseOutAt: string | null;
    replacementPlanId: string | null;
  };
  if (plan) {
    planPayload = {
      id: plan.id,
      status: plan.status,
      phaseOutAt: plan.phaseOutAt ?? null,
      replacementPlanId: plan.replacementPlanId ?? null,
    };
  } else if (isOwnerStarter) {
    planPayload = {
      id: null,
      status: "active",
      phaseOutAt: null,
      replacementPlanId: null,
    };
  } else {
    planPayload = {
      id: null,
      status: "missing",
      phaseOutAt: null,
      replacementPlanId: null,
    };
  }

  return NextResponse.json({
    externalUserId,
    source: "openmeter",
    actionRequired,
    plan: planPayload,
    pendingCancel,
    subscription: {
      id: omSubscription.id,
      status: omSubscription.status,
      planId: plan?.id ?? null,
      planName: plan?.name ?? (isOwnerStarter ? OWNER_STARTER_PLAN_NAME : null),
      // Owner Starter is a platform plan (no Neon row); match local Starter typing.
      planType: plan?.type ?? (isOwnerStarter ? "free" : null),
      openmeterPlanKey: omSubscription.planKey,
      currentPeriodStart: omSubscription.activeFrom,
      currentPeriodEnd: omSubscription.activeTo,
      openmeterSubscriptionId: omSubscription.id,
      stripeCheckoutSessionId: null,
      createdAt: null,
      cancelledAt: null,
    },
  });
}

/**
 * DELETE /api/v1/apps/{clientId}/users/{externalUserId}/subscription
 *
 * Schedule cancel at next billing cycle (owner-paid parity).
 * Body: `{ confirm: true }`.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; externalUserId: string }> },
) {
  const { id: clientId, externalUserId: raw } = await params;
  const externalUserId = tryDecodeURIComponent(raw)?.trim() ?? "";
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required" },
      { status: 400 },
    );
  }
  const access = await authorizeAppForBilling(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObject(request);

  try {
    const result = await cancelAppUserSubscription({
      clientId: access.app.id,
      externalUserId,
      confirm: readConfirmFlag(body),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AppUserSubscriptionCancelError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: appUserSubscriptionCancelHttpStatus(err.code) },
      );
    }
    console.error("App-user subscription cancel failed", err);
    return NextResponse.json(
      { error: "Subscription cancel failed", code: "cancel_failed" },
      { status: 502 },
    );
  }
}
