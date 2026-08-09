import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appUsers, plans } from "@/db/schema";
import {
  DEFAULT_AUTO_TOP_UP_USD_MICROS,
  effectiveAutoTopUpUsdMicros,
  effectiveSoftNegativeUsdMicros,
  parseAutoTopUpUsdMicrosInput,
} from "@/lib/billing/auto-topup-settings";
import { getAppUserAutoTopUpPrefs } from "@/lib/billing/auto-topup-worker";
import { authorizeOwnerWalletM2m } from "@/lib/billing/owner-wallet-m2m-auth";
import {
  formatUsdMicrosForDisplay,
  resolvedPayPerUseBehavior,
} from "@/lib/billing/pay-per-use-threshold";
import { getUnbilledDebtUsdMicros } from "@/lib/billing/unbilled-debt";
import {
  readOptionalExternalUserId,
  resolveWalletBillingTarget,
} from "@/lib/billing/wallet-billing-target";
import { listAppUserPaymentMethods } from "@/lib/openmeter/app-user-payment-method";
import {
  getAppBillingConfig,
} from "@/lib/openmeter/billing-profiles";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { ownerHasChargeablePaymentMethod } from "@/lib/openmeter/owner-payment-method";

async function buildAutoTopUpPayload(input: {
  appId: string;
  externalUserId: string | null;
  softNegativeUsdMicros: string | null;
}) {
  const softNegative = effectiveSoftNegativeUsdMicros(
    input.softNegativeUsdMicros,
  );
  if (!input.externalUserId) {
    return {
      enabled: false,
      amountUsdMicros: DEFAULT_AUTO_TOP_UP_USD_MICROS.toString(),
      amountUsd: formatUsdMicrosForDisplay(
        DEFAULT_AUTO_TOP_UP_USD_MICROS.toString(),
      ),
      beforeSoftNegative: true,
      softNegativeUsdMicros: softNegative.toString(),
      softNegativeUsd: formatUsdMicrosForDisplay(softNegative.toString()),
      unbilledDebtUsdMicros: null as string | null,
      unbilledDebtUsd: null as string | null,
    };
  }
  const prefs = await getAppUserAutoTopUpPrefs({
    appId: input.appId,
    externalUserId: input.externalUserId,
  });
  let debt: bigint | null = null;
  try {
    debt = await getUnbilledDebtUsdMicros({
      clientId: input.appId,
      externalUserId: input.externalUserId,
    });
  } catch {
    debt = null;
  }
  return {
    enabled: prefs.enabled,
    amountUsdMicros: prefs.amountUsdMicros.toString(),
    amountUsd: formatUsdMicrosForDisplay(prefs.amountUsdMicros.toString()),
    beforeSoftNegative: prefs.beforeSoftNegative,
    softNegativeUsdMicros: softNegative.toString(),
    softNegativeUsd: formatUsdMicrosForDisplay(softNegative.toString()),
    unbilledDebtUsdMicros: debt?.toString() ?? null,
    unbilledDebtUsd:
      debt != null ? formatUsdMicrosForDisplay(debt.toString()) : null,
  };
}

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

  const billingConfig = await getAppBillingConfig(access.app.id);
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

  if (billingTarget.target.mode === "merchant") {
    const endUserId = billingTarget.target.externalUserId;
    const [trialBalance, paymentMethods, usagePlanRows, autoTopUp] =
      await Promise.all([
        getTrialCreditBalance({
          clientId,
          externalUserId: endUserId,
        }),
        listAppUserPaymentMethods({
          clientId: access.app.id,
          externalUserId: endUserId,
        }).catch(() => null),
        usagePlanRowsPromise,
        buildAutoTopUpPayload({
          appId: access.app.id,
          externalUserId: endUserId,
          softNegativeUsdMicros: billingConfig?.softNegativeUsdMicros ?? null,
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
      clientId,
      balance,
      paymentMethod: {
        hasDefault: paymentMethods
          ? paymentMethods.some((pm) => pm.isDefault)
          : null,
      },
      autoTopUp,
      payPerUsePlans: usagePlanRows.map((usagePlan) => ({
        planId: usagePlan.id,
        planName: usagePlan.name,
        chargeThresholdUsdMicros: usagePlan.chargeThresholdUsdMicros ?? null,
        resolvedBehavior: resolvedPayPerUseBehavior(
          usagePlan.chargeThresholdUsdMicros,
        ),
      })),
      settlement: {
        order: "credits_then_auto_top_up",
        description:
          "Prepaid credits first. With auto top-up enabled, a mint balance reject (or soft-negative lead window) charges the default card and grants credits.",
      },
    });
  }

  const [ownerBalance, hasDefaultPaymentMethod, usagePlanRows, autoTopUp] =
    await Promise.all([
      getOwnerPrepaidCreditBalance(billingTarget.target.ownerUserId),
      ownerHasChargeablePaymentMethod(billingTarget.target.ownerUserId),
      usagePlanRowsPromise,
      buildAutoTopUpPayload({
        appId: access.app.id,
        externalUserId: null,
        softNegativeUsdMicros: billingConfig?.softNegativeUsdMicros ?? null,
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
    autoTopUp,
    payPerUsePlans: usagePlanRows.map((usagePlan) => ({
      planId: usagePlan.id,
      planName: usagePlan.name,
      chargeThresholdUsdMicros: usagePlan.chargeThresholdUsdMicros ?? null,
      resolvedBehavior: resolvedPayPerUseBehavior(
        usagePlan.chargeThresholdUsdMicros,
      ),
    })),
    settlement: {
      order: "credits_then_auto_top_up",
      description:
        "Prepaid credits first. Soft-negative is app-wide; auto top-up is per end-user (merchant mode).",
    },
  });
}

/**
 * PATCH /api/v1/apps/{clientId}/billing/wallet — update per-user auto top-up
 * prefs (merchant end-user via externalUserId).
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const externalUserId = readOptionalExternalUserId(
    typeof body.externalUserId === "string"
      ? body.externalUserId
      : request.nextUrl.searchParams.get("externalUserId"),
  );
  if (!externalUserId) {
    return NextResponse.json(
      { error: "externalUserId is required to update auto top-up" },
      { status: 400 },
    );
  }

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
  if (billingTarget.target.mode !== "merchant") {
    return NextResponse.json(
      { error: "Auto top-up prefs apply to merchant end-users only" },
      { status: 400 },
    );
  }

  const updates: {
    autoTopUpEnabled?: boolean;
    autoTopUpUsdMicros?: string | null;
    autoTopUpBeforeSoftNegative?: boolean;
  } = {};

  if (body.autoTopUpEnabled !== undefined) {
    if (typeof body.autoTopUpEnabled !== "boolean") {
      return NextResponse.json(
        { error: "autoTopUpEnabled must be a boolean" },
        { status: 400 },
      );
    }
    updates.autoTopUpEnabled = body.autoTopUpEnabled;
  }
  if (body.autoTopUpBeforeSoftNegative !== undefined) {
    if (typeof body.autoTopUpBeforeSoftNegative !== "boolean") {
      return NextResponse.json(
        { error: "autoTopUpBeforeSoftNegative must be a boolean" },
        { status: 400 },
      );
    }
    updates.autoTopUpBeforeSoftNegative = body.autoTopUpBeforeSoftNegative;
  }
  if (body.autoTopUpUsdMicros !== undefined) {
    const parsed = parseAutoTopUpUsdMicrosInput(body.autoTopUpUsdMicros);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    updates.autoTopUpUsdMicros = parsed.value;
  } else if (body.autoTopUpUsd !== undefined) {
    // Accept dollar string via micros conversion from display helpers' inverse.
    const { parseTopUpAmountUsd } = await import("@/lib/stripe/topup-checkout");
    const dollars = parseTopUpAmountUsd(body.autoTopUpUsd);
    if (!dollars.ok) {
      return NextResponse.json({ error: dollars.error }, { status: 400 });
    }
    updates.autoTopUpUsdMicros = dollars.amountUsdMicros.toString();
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      {
        error:
          "Provide autoTopUpEnabled, autoTopUpUsdMicros/autoTopUpUsd, and/or autoTopUpBeforeSoftNegative",
      },
      { status: 400 },
    );
  }

  const endUserId = billingTarget.target.externalUserId;
  const updated = await db
    .update(appUsers)
    .set(updates)
    .where(
      and(
        eq(appUsers.clientId, access.app.id),
        eq(appUsers.externalUserId, endUserId),
      ),
    )
    .returning({
      id: appUsers.id,
      autoTopUpEnabled: appUsers.autoTopUpEnabled,
      autoTopUpUsdMicros: appUsers.autoTopUpUsdMicros,
      autoTopUpBeforeSoftNegative: appUsers.autoTopUpBeforeSoftNegative,
    });

  if (updated.length === 0) {
    return NextResponse.json(
      { error: "End-user not found for this app" },
      { status: 404 },
    );
  }

  const row = updated[0]!;
  const amount = effectiveAutoTopUpUsdMicros(row.autoTopUpUsdMicros);
  return NextResponse.json({
    externalUserId: endUserId,
    autoTopUp: {
      enabled: row.autoTopUpEnabled,
      amountUsdMicros: amount.toString(),
      amountUsd: formatUsdMicrosForDisplay(amount.toString()),
      beforeSoftNegative: row.autoTopUpBeforeSoftNegative,
    },
  });
}
