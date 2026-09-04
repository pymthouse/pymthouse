import { NextRequest, NextResponse } from "next/server";

import { requireEndUserRouteAuth } from "@/lib/auth/end-user";
import { listAppUserBillingInvoices } from "@/lib/billing/app-user-invoices-read";
import { loadAppUserSubscriptionView } from "@/lib/billing/app-user-subscription-view";
import { loadBillingState } from "@/lib/billing/billing-state-read";
import { loadMerchantAppUserWallet } from "@/lib/billing/merchant-app-user-wallet";
import { clampPageParam } from "@/lib/billing/wallet-http";
import {
  listAppUserPaymentMethods,
} from "@/lib/openmeter/app-user-payment-method";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { readAppUserCreditBalance } from "@/lib/openmeter/entitlements";

export const MERCHANT_BILLING_REQUIRED_CODE = "merchant_billing_required";

const MERCHANT_BILLING_REQUIRED_BODY = {
  error: "End-user billing is merchant-mode only",
  code: MERCHANT_BILLING_REQUIRED_CODE,
};

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

async function requireMeRetailBillingAuth(
  request: NextRequest,
  clientId: string,
  resourceLabel: string,
) {
  const gate = await requireMeBillingAuth(request, clientId, resourceLabel);
  if ("response" in gate) {
    return gate;
  }
  const config = await getAppBillingConfig(gate.auth.developerAppId);
  if (config?.billingMode !== "merchant") {
    return {
      response: NextResponse.json(MERCHANT_BILLING_REQUIRED_BODY, { status: 403 }),
    };
  }
  return gate;
}

/** GET /apps/{clientId}/me/billing/allowances */
export async function handleEndUserMeAllowancesGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireMeRetailBillingAuth(request, clientId, "allowances");
  if ("response" in gate) return gate.response;

  const currency = request.nextUrl.searchParams.get("filter[currency][eq]")?.trim();
  const featureKey = request.nextUrl.searchParams
    .get("filter[feature_key][eq]")
    ?.trim();

  let balance: Awaited<ReturnType<typeof readAppUserCreditBalance>> = null;
  try {
    balance = await readAppUserCreditBalance({
      clientId: gate.auth.developerAppId,
      externalUserId: gate.auth.externalUserId,
      currency: currency || undefined,
      featureKey: featureKey || undefined,
    });
  } catch {
    balance = null;
  }
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

  const result = await listAppUserBillingInvoices({
    appId: gate.auth.developerAppId,
    externalUserId: gate.auth.externalUserId,
    page: normalizedPage,
    pageSize: normalizedPageSize,
  });
  return NextResponse.json(result);
}

/** GET /apps/{clientId}/me/billing/state */
export async function handleEndUserMeBillingStateGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireMeRetailBillingAuth(request, clientId, "billing state");
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
  const gate = await requireMeRetailBillingAuth(request, clientId, "wallet");
  if ("response" in gate) return gate.response;

  return loadMerchantAppUserWallet({
    publicClientId: gate.auth.publicClientId,
    appId: gate.auth.developerAppId,
    externalUserId: gate.auth.externalUserId,
  });
}

/** GET /apps/{clientId}/me/billing/subscription */
export async function handleEndUserMeSubscriptionGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireMeRetailBillingAuth(request, clientId, "subscription");
  if ("response" in gate) return gate.response;

  return loadAppUserSubscriptionView({
    appId: gate.auth.developerAppId,
    externalUserId: gate.auth.externalUserId,
  });
}
