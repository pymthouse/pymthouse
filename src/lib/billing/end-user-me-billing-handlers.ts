import { NextRequest, NextResponse } from "next/server";

import { type EndUserAuth, requireEndUserRouteAuth } from "@/lib/auth/end-user";
import { appUserInvoiceLinksResponse } from "@/lib/billing/app-user-invoice-links";
import { listAppUserBillingInvoices } from "@/lib/billing/app-user-invoices-read";
import { loadAppUserBillingLedger } from "@/lib/billing/app-user-ledger";
import { loadAppUserSubscriptionView } from "@/lib/billing/app-user-subscription-view";
import { loadBillingState } from "@/lib/billing/billing-state-read";
import { loadMerchantAppUserWallet } from "@/lib/billing/merchant-app-user-wallet";
import {
  clampPageParam,
  walletUpstreamErrorResponse,
} from "@/lib/billing/wallet-http";
import {
  listAppUserPaymentMethods,
} from "@/lib/openmeter/app-user-payment-method";
import {
  isAppUserRetailSubject,
  resolveOpenMeterBillingIdentity,
} from "@/lib/openmeter/billing-identity";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { readAppUserCreditBalance } from "@/lib/openmeter/entitlements";

export const MERCHANT_BILLING_REQUIRED_CODE = "merchant_billing_required";

const MERCHANT_BILLING_REQUIRED_BODY = {
  error: "End-user billing is merchant-mode only",
  code: MERCHANT_BILLING_REQUIRED_CODE,
};

export const OWNER_WALLET_NOT_APP_USER_CODE = "owner_wallet_not_app_user";

export type EndUserBillingGate = { auth: EndUserAuth } | { response: Response };

/**
 * Gate for `/apps/{clientId}/me/billing/*`.
 *
 * - End-user Bearer bound to path `{clientId}`; a query (or `body`) subject is
 *   400 and M2M Basic is 401 — the subject is the credential only.
 * - `merchantOnly` money surfaces (wallet, credits, state, plan) need live
 *   `billing_mode=merchant`; the JWT `billing_mode` claim is only a hint.
 * - The subject's retail billing must be its own end-user customer: an owner
 *   or platform-wallet credential gets 403 `owner_wallet_not_app_user`.
 */
export async function requireEndUserBillingAuth(
  request: NextRequest,
  clientId: string,
  resourceLabel: string,
  options: { merchantOnly?: boolean; body?: Record<string, unknown> | null } = {},
): Promise<EndUserBillingGate> {
  const publicClientId = clientId.trim();
  if (!publicClientId) {
    return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  const gate = await requireEndUserRouteAuth(
    request,
    publicClientId,
    resourceLabel,
    options.body,
  );
  if ("response" in gate) {
    return gate;
  }

  if (options.merchantOnly) {
    const config = await getAppBillingConfig(gate.auth.developerAppId);
    if (config?.billingMode !== "merchant") {
      return {
        response: NextResponse.json(MERCHANT_BILLING_REQUIRED_BODY, { status: 403 }),
      };
    }
  }

  let identity: Awaited<ReturnType<typeof resolveOpenMeterBillingIdentity>>;
  try {
    identity = await resolveOpenMeterBillingIdentity({
      clientId: gate.auth.publicClientId,
      externalUserId: gate.auth.externalUserId,
    });
  } catch (err) {
    console.warn(
      "me-billing: identity resolve failed",
      err instanceof Error ? err.message : String(err),
    );
    return {
      response: NextResponse.json({ error: "Billing unavailable" }, { status: 503 }),
    };
  }
  if (!isAppUserRetailSubject(identity)) {
    return {
      response: NextResponse.json(
        {
          error:
            "This credential bills a platform wallet; use the owner billing APIs, not /me/billing",
          code: OWNER_WALLET_NOT_APP_USER_CODE,
        },
        { status: 403 },
      ),
    };
  }
  return gate;
}

/** GET /apps/{clientId}/me/billing/allowances */
export async function handleEndUserMeAllowancesGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireEndUserBillingAuth(request, clientId, "allowances", {
    merchantOnly: true,
  });
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
  const gate = await requireEndUserBillingAuth(request, clientId, "payment-methods");
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
  const gate = await requireEndUserBillingAuth(request, clientId, "invoices");
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
  const gate = await requireEndUserBillingAuth(request, clientId, "billing state", {
    merchantOnly: true,
  });
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
  const gate = await requireEndUserBillingAuth(request, clientId, "wallet", {
    merchantOnly: true,
  });
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
  const gate = await requireEndUserBillingAuth(request, clientId, "subscription", {
    merchantOnly: true,
  });
  if ("response" in gate) return gate.response;

  try {
    return await loadAppUserSubscriptionView({
      appId: gate.auth.developerAppId,
      externalUserId: gate.auth.externalUserId,
    });
  } catch (err) {
    console.warn(
      "me-billing: subscription read failed",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Billing unavailable" }, { status: 503 });
  }
}

/** GET /apps/{clientId}/me/billing/wallet/transactions — merchant prepaid ledger. */
export async function handleEndUserMeWalletTransactionsGet(
  request: NextRequest,
  clientId: string,
): Promise<Response> {
  const gate = await requireEndUserBillingAuth(request, clientId, "wallet transactions", {
    merchantOnly: true,
  });
  if ("response" in gate) return gate.response;

  try {
    const result = await loadAppUserBillingLedger({
      appId: gate.auth.developerAppId,
      publicClientId: gate.auth.publicClientId,
      externalUserId: gate.auth.externalUserId,
    });
    return NextResponse.json({ items: result.items, degraded: result.degraded });
  } catch (err) {
    return walletUpstreamErrorResponse(err, "transaction ledger");
  }
}

/** GET /apps/{clientId}/me/billing/invoices/{invoiceId}/hosted-url */
export async function handleEndUserMeInvoiceHostedUrlGet(
  request: NextRequest,
  clientId: string,
  rawInvoiceId: string,
): Promise<Response> {
  const gate = await requireEndUserBillingAuth(request, clientId, "invoices");
  if ("response" in gate) return gate.response;

  return appUserInvoiceLinksResponse({
    appId: gate.auth.developerAppId,
    externalUserId: gate.auth.externalUserId,
    rawInvoiceId,
  });
}
