import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { loadBillingState } from "@/lib/billing/billing-state-read";
import { loadMerchantAppUserWallet } from "@/lib/billing/merchant-app-user-wallet";
import {
  authorizeOwnerWalletM2m,
  readJsonObjectBody,
} from "@/lib/billing/owner-wallet-m2m-auth";
import {
  formatUsdMicrosForDisplay,
  resolvedPayPerUseBehavior,
} from "@/lib/billing/pay-per-use-threshold";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";
import { listAppUserPaymentMethods } from "@/lib/openmeter/app-user-payment-method";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import { ownerHasChargeablePaymentMethod } from "@/lib/openmeter/owner-payment-method";
import {
  DEFAULT_AUTO_TOP_UP_USD_MICROS,
  loadAppUserAutoTopUpPrefs,
  parseAutoTopUpPatch,
  saveAppUserAutoTopUpPrefs,
} from "@/lib/stripe/auto-topup";
import { parseTopUpAmountUsd } from "@/lib/stripe/topup-checkout";

/**
 * GET /api/v1/apps/{clientId}/billing/wallet — prepaid wallet summary for
 * Builder M2M integrations. Branches on `app_billing_config.billing_mode`:
 * merchant → end-user balance (`externalUserId` required); otherwise owner rollup.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeOwnerWalletM2m(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const externalUserId = readOptionalExternalUserId(
    request.nextUrl.searchParams.get("externalUserId"),
  );
  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId,
  });
  if (!billingTarget.ok) {
    return NextResponse.json(
      { error: billingTarget.error },
      { status: billingTarget.status },
    );
  }

  if (billingTarget.target.mode === "merchant") {
    return loadMerchantAppUserWallet({
      publicClientId: clientId,
      appId: access.app.id,
      externalUserId: billingTarget.target.externalUserId,
    });
  }

  const usagePlanRowsPromise = db
    .select({
      id: plans.id,
      name: plans.name,
      chargeThresholdUsdMicros: plans.chargeThresholdUsdMicros,
    })
    .from(plans)
    .where(
      and(
        eq(plans.clientId, access.app.id),
        eq(plans.type, "usage"),
        eq(plans.status, "active"),
      ),
    )
    .orderBy(desc(plans.updatedAt));

  const [ownerBalance, hasDefaultPaymentMethod, usagePlanRows, billingState] =
    await Promise.all([
      getOwnerPrepaidCreditBalance(billingTarget.target.ownerUserId),
      ownerHasChargeablePaymentMethod(billingTarget.target.ownerUserId),
      usagePlanRowsPromise,
      loadBillingState({
        publicClientId: clientId,
        appId: access.app.id,
        target: billingTarget.target,
        externalUserId,
      }),
    ]);

  return NextResponse.json({
    clientId,
    balance: ownerBalance
      ? {
          usdMicros: ownerBalance.balanceUsdMicros,
          usd: formatUsdMicrosForDisplay(ownerBalance.balanceUsdMicros),
          lifetimeGrantedUsdMicros: ownerBalance.lifetimeGrantedUsdMicros,
          consumedUsdMicros: ownerBalance.consumedUsdMicros,
        }
      : null,
    paymentMethod: {
      hasDefault: hasDefaultPaymentMethod,
    },
    autoTopUp: null,
    billingState,
    payPerUsePlans: usagePlanRows.map((usagePlan) => ({
      planId: usagePlan.id,
      planName: usagePlan.name,
      chargeThresholdUsdMicros: usagePlan.chargeThresholdUsdMicros ?? null,
      resolvedBehavior: resolvedPayPerUseBehavior(),
    })),
  });
}

/**
 * PATCH /api/v1/apps/{clientId}/billing/wallet — merchant end-user auto-top-up
 * prefs. Body: `{ externalUserId, enabled, amountUsd? }`.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await authorizeOwnerWalletM2m(request, clientId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await readJsonObjectBody(request);
  const billingTarget = await resolveWalletBillingTarget({
    appId: access.app.id,
    ownerUserId: access.ownerUserId,
    externalUserId: readOptionalExternalUserId(body.externalUserId),
  });
  if (!billingTarget.ok) {
    return NextResponse.json(
      { error: billingTarget.error },
      { status: billingTarget.status },
    );
  }
  if (billingTarget.target.mode !== "merchant") {
    return NextResponse.json(
      {
        error: "Auto top-up is available for merchant end-users only",
        code: "auto_topup_merchant_only",
      },
      { status: 409 },
    );
  }

  const parsed = parseAutoTopUpPatch(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const endUserId = billingTarget.target.externalUserId;
  if (parsed.enabled) {
    const methods = await listAppUserPaymentMethods({
      clientId: access.app.id,
      externalUserId: endUserId,
    }).catch(() => []);
    if (!methods.some((pm) => pm.isDefault)) {
      return NextResponse.json(
        {
          error: "Add a payment method before enabling auto top-up",
          code: "payment_method_required",
        },
        { status: 409 },
      );
    }
  }

  const existing = await loadAppUserAutoTopUpPrefs({
    appId: access.app.id,
    externalUserId: endUserId,
  });
  let amountUsdMicros = parsed.amountUsdMicros;
  if (amountUsdMicros === undefined) {
    if (existing.amountUsd) {
      const stored = parseTopUpAmountUsd(existing.amountUsd);
      amountUsdMicros = stored.ok
        ? stored.amountUsdMicros
        : DEFAULT_AUTO_TOP_UP_USD_MICROS;
    } else {
      amountUsdMicros = DEFAULT_AUTO_TOP_UP_USD_MICROS;
    }
  }

  const autoTopUp = await saveAppUserAutoTopUpPrefs({
    appId: access.app.id,
    externalUserId: endUserId,
    enabled: parsed.enabled,
    amountUsdMicros,
  });
  return NextResponse.json({
    externalUserId: endUserId,
    autoTopUp,
  });
}
