import { and, desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { requireEndUserRouteAuth } from "@/lib/auth/end-user";
import {
  buildAppUserSubscriptionPlanPayload,
  resolveAppUserSubscriptionActionRequired,
  resolveAppUserSubscriptionPlanName,
} from "@/lib/billing/app-user-subscription-display";
import { loadBillingState } from "@/lib/billing/billing-state-read";
import { clampPageParam } from "@/lib/billing/wallet-http";
import {
  formatUsdMicrosForDisplay,
  resolvedPayPerUseBehavior,
} from "@/lib/billing/pay-per-use-threshold";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import {
  listAppUserPaymentMethods,
  appUserPaymentMethodRequiresMerchantConnect,
} from "@/lib/openmeter/app-user-payment-method";
import { resolveAppUserPendingCancel } from "@/lib/openmeter/app-user-subscription-lifecycle";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import {
  getTrialCreditBalance,
  readAppUserCreditBalance,
} from "@/lib/openmeter/entitlements";
import { listAppUserInvoices } from "@/lib/openmeter/invoices";
import { isOwnerStarterPlanKey } from "@/lib/openmeter/owner-starter-key";
import {
  getPendingOpenMeterSubscriptionForAppUser,
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
} from "@/lib/openmeter/subscription-read";
import { includedDiscountUsdMicrosForPlan } from "@/lib/openmeter/spendable-allowance";
import { loadAppUserAutoTopUpPrefs } from "@/lib/stripe/auto-topup";
import { listMerchantConnectInvoicesForAppUser } from "@/lib/stripe/merchant-connect";

async function requireMeBillingAuth(
  request: NextRequest,
  clientId: string,
  resourceLabel: string,
) {
  const publicClientId = clientId.trim();
  if (!publicClientId) {
    return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return requireEndUserRouteAuth(request, publicClientId, resourceLabel);
}

/** GET /apps/{clientId}/me/billing/allowances */
export async function handleEndUserMeAllowancesGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireMeBillingAuth(request, clientId, "allowances");
  if ("response" in gate) return gate.response;

  const currency = request.nextUrl.searchParams.get("filter[currency][eq]")?.trim();
  const featureKey = request.nextUrl.searchParams
    .get("filter[feature_key][eq]")
    ?.trim();

  const balance = await readAppUserCreditBalance({
    clientId: gate.auth.developerAppId,
    externalUserId: gate.auth.externalUserId,
    currency: currency || undefined,
    featureKey: featureKey || undefined,
  });
  if (!balance) {
    return NextResponse.json({ error: "OpenMeter not configured" }, { status: 503 });
  }

  return NextResponse.json({
    externalUserId: gate.auth.externalUserId,
    customerId: balance.customerId,
    currency: balance.currency,
    live: balance.live,
    pending: balance.pending,
    settled: balance.settled,
    retrievedAt: balance.retrievedAt,
  });
}

/** GET /apps/{clientId}/me/billing/payment-methods */
export async function handleEndUserMePaymentMethodsGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireMeBillingAuth(request, clientId, "payment-methods");
  if ("response" in gate) return gate.response;

  let paymentMethods: Awaited<ReturnType<typeof listAppUserPaymentMethods>> = [];
  try {
    paymentMethods = await listAppUserPaymentMethods({
      clientId: gate.auth.developerAppId,
      externalUserId: gate.auth.externalUserId,
    });
  } catch {
    paymentMethods = [];
  }
  return NextResponse.json({ paymentMethods });
}

/** GET /apps/{clientId}/me/billing/invoices */
export async function handleEndUserMeInvoicesGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireMeBillingAuth(request, clientId, "invoices");
  if ("response" in gate) return gate.response;

  const url = new URL(request.url);
  const normalizedPage = clampPageParam(url.searchParams.get("page"), 1, 10_000);
  const normalizedPageSize = clampPageParam(
    url.searchParams.get("pageSize"),
    20,
    100,
  );

  try {
    const config = await getAppBillingConfig(gate.auth.developerAppId);
    const result = appUserPaymentMethodRequiresMerchantConnect(config)
      ? await listMerchantConnectInvoicesForAppUser({
          clientId: gate.auth.developerAppId,
          externalUserId: gate.auth.externalUserId,
          page: normalizedPage,
          pageSize: normalizedPageSize,
        })
      : await listOwnerRollupInvoices({
          clientId: gate.auth.developerAppId,
          externalUserId: gate.auth.externalUserId,
          page: normalizedPage,
          pageSize: normalizedPageSize,
        });
    return NextResponse.json(result);
  } catch (err) {
    console.warn(
      "me-billing-invoices: list failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({
      items: [],
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalCount: 0,
    });
  }
}

async function listOwnerRollupInvoices(input: {
  clientId: string;
  externalUserId: string;
  page: number;
  pageSize: number;
}) {
  if (!isHostedAdminClientAvailable()) {
    return { items: [], page: input.page, pageSize: input.pageSize, totalCount: 0 };
  }
  return listAppUserInvoices({
    client: getHostedAdminClient(),
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    page: input.page,
    pageSize: input.pageSize,
  });
}

/** GET /apps/{clientId}/me/billing/state */
export async function handleEndUserMeBillingStateGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireMeBillingAuth(request, clientId, "billing state");
  if ("response" in gate) return gate.response;

  const state = await loadBillingState({
    publicClientId: gate.auth.publicClientId,
    appId: gate.auth.developerAppId,
    target: { mode: "merchant", externalUserId: gate.auth.externalUserId },
    externalUserId: gate.auth.externalUserId,
  });

  return NextResponse.json(state, {
    headers: { "Cache-Control": "no-store" },
  });
}

/** GET /apps/{clientId}/me/billing/wallet — merchant prepaid wallet only. */
export async function handleEndUserMeWalletGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireMeBillingAuth(request, clientId, "wallet");
  if ("response" in gate) return gate.response;

  const config = await getAppBillingConfig(gate.auth.developerAppId);
  if (config?.billingMode !== "merchant") {
    return NextResponse.json(
      {
        error: "End-user wallet is merchant-mode only",
        code: "merchant_wallet_required",
      },
      { status: 403 },
    );
  }

  const endUserId = gate.auth.externalUserId;
  const usagePlanRowsPromise = db
    .select({
      id: plans.id,
      name: plans.name,
      chargeThresholdUsdMicros: plans.chargeThresholdUsdMicros,
    })
    .from(plans)
    .where(
      and(
        eq(plans.clientId, gate.auth.developerAppId),
        eq(plans.type, "usage"),
        eq(plans.status, "active"),
      ),
    )
    .orderBy(desc(plans.updatedAt));

  const [trialBalance, paymentMethods, usagePlanRows, billingState, autoTopUp] =
    await Promise.all([
      getTrialCreditBalance({
        clientId: gate.auth.publicClientId,
        externalUserId: endUserId,
      }),
      listAppUserPaymentMethods({
        clientId: gate.auth.developerAppId,
        externalUserId: endUserId,
      }).catch(() => null),
      usagePlanRowsPromise,
      loadBillingState({
        publicClientId: gate.auth.publicClientId,
        appId: gate.auth.developerAppId,
        target: { mode: "merchant", externalUserId: endUserId },
        externalUserId: endUserId,
      }),
      loadAppUserAutoTopUpPrefs({
        appId: gate.auth.developerAppId,
        externalUserId: endUserId,
      }),
    ]);

  const balance = trialBalance
    ? {
        usdMicros: trialBalance.balanceUsdMicros,
        usd: formatUsdMicrosForDisplay(trialBalance.balanceUsdMicros),
        lifetimeGrantedUsdMicros: trialBalance.lifetimeGrantedUsdMicros,
        consumedUsdMicros: trialBalance.consumedUsdMicros,
      }
    : null;

  return NextResponse.json({
    clientId: gate.auth.publicClientId,
    balance,
    paymentMethod: {
      hasDefault: paymentMethods
        ? paymentMethods.some((pm) => pm.isDefault)
        : null,
    },
    autoTopUp,
    billingState,
    payPerUsePlans: usagePlanRows.map((usagePlan) => ({
      planId: usagePlan.id,
      planName: usagePlan.name,
      chargeThresholdUsdMicros: usagePlan.chargeThresholdUsdMicros ?? null,
      resolvedBehavior: resolvedPayPerUseBehavior(),
    })),
  });
}

type PlanSurface = {
  id: string | null;
  name: string | null;
  type: string | null;
  includedUsage: {
    usdMicros: string;
    usd: string;
  } | null;
  effectiveAt: string | null;
};

async function buildPlanSurface(input: {
  appId: string;
  subscription: NonNullable<
    Awaited<ReturnType<typeof getPrimaryOpenMeterSubscriptionForAppUser>>
  >;
}): Promise<PlanSurface> {
  const resolvedPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    input.appId,
    input.subscription,
  );
  const planRows = resolvedPlanId
    ? await db.select().from(plans).where(eq(plans.id, resolvedPlanId)).limit(1)
    : [];
  const plan = planRows[0] ?? null;
  const isOwnerStarter = isOwnerStarterPlanKey(input.subscription.planKey);
  const planName = resolveAppUserSubscriptionPlanName({
    plan,
    planKey: input.subscription.planKey,
  });
  let includedMicros: bigint | null = null;
  if (plan) {
    includedMicros = includedDiscountUsdMicrosForPlan(plan);
  } else if (isOwnerStarter) {
    includedMicros = includedDiscountUsdMicrosForPlan({
      includedUsdMicros: null,
      isStarterDefault: true,
    });
  }
  return {
    id: plan?.id ?? null,
    name: planName,
    type: plan?.type ?? (isOwnerStarter ? "free" : null),
    includedUsage:
      includedMicros != null
        ? {
            usdMicros: includedMicros.toString(),
            usd: formatUsdMicrosForDisplay(includedMicros.toString()),
          }
        : null,
    effectiveAt: input.subscription.activeFrom,
  };
}

/** GET /apps/{clientId}/me/billing/subscription */
export async function handleEndUserMeSubscriptionGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireMeBillingAuth(request, clientId, "subscription");
  if ("response" in gate) return gate.response;

  const externalUserId = gate.auth.externalUserId;
  const appId = gate.auth.developerAppId;

  const [omSubscription, pendingOm] = await Promise.all([
    getPrimaryOpenMeterSubscriptionForAppUser({
      clientId: appId,
      externalUserId,
    }),
    getPendingOpenMeterSubscriptionForAppUser({
      clientId: appId,
      externalUserId,
    }),
  ]);

  if (!omSubscription) {
    return NextResponse.json({
      externalUserId,
      subscription: null,
      pendingCancel: null,
      livePlan: null,
      pendingPlan: null,
      source: "openmeter",
    });
  }

  let pendingCancel: Awaited<ReturnType<typeof resolveAppUserPendingCancel>> = null;
  try {
    pendingCancel = await resolveAppUserPendingCancel({
      clientId: appId,
      subscription: omSubscription,
    });
  } catch (err) {
    console.error("Failed to resolve pendingCancel for app user", err);
  }

  const resolvedPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    appId,
    omSubscription,
  );
  const planRows = resolvedPlanId
    ? await db.select().from(plans).where(eq(plans.id, resolvedPlanId)).limit(1)
    : [];
  const plan = planRows[0] ?? null;
  const isOwnerStarter = isOwnerStarterPlanKey(omSubscription.planKey);
  const planName = resolveAppUserSubscriptionPlanName({
    plan,
    planKey: omSubscription.planKey,
  });
  const actionRequired = resolveAppUserSubscriptionActionRequired({
    plan,
    isOwnerStarter,
  });
  const planPayload = buildAppUserSubscriptionPlanPayload({
    plan,
    isOwnerStarter,
  });

  const [livePlan, pendingPlan] = await Promise.all([
    buildPlanSurface({ appId, subscription: omSubscription }),
    pendingOm
      ? buildPlanSurface({ appId, subscription: pendingOm })
      : Promise.resolve(null),
  ]);

  return NextResponse.json({
    externalUserId,
    source: "openmeter",
    actionRequired,
    plan: planPayload,
    pendingCancel,
    livePlan,
    pendingPlan,
    subscription: {
      id: omSubscription.id,
      status: omSubscription.status,
      planId: plan?.id ?? null,
      planName,
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
