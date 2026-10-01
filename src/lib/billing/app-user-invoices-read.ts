import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { appUserPaymentMethodRequiresMerchantConnect } from "@/lib/openmeter/app-user-payment-method";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { listAppUserInvoices } from "@/lib/openmeter/invoices";
import { listMerchantConnectInvoicesForAppUser } from "@/lib/stripe/merchant-connect";

export type AppUserInvoicePage = {
  items: unknown[];
  page: number;
  pageSize: number;
  totalCount: number;
};

async function listOwnerRollupInvoices(input: {
  clientId: string;
  externalUserId: string;
  page: number;
  pageSize: number;
}): Promise<AppUserInvoicePage> {
  if (!isHostedAdminClientAvailable()) {
    return {
      items: [],
      page: input.page,
      pageSize: input.pageSize,
      totalCount: 0,
    };
  }
  return listAppUserInvoices({
    client: getHostedAdminClient(),
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    page: input.page,
    pageSize: input.pageSize,
  });
}

/**
 * End-user invoice list. Merchant apps read Connected Account invoices;
 * owner-rollup apps retain the OpenMeter customer list. Fail-open to an empty
 * page so Starter / sandbox users without a Stripe customer still render.
 */
export async function listAppUserBillingInvoices(input: {
  appId: string;
  externalUserId: string;
  page: number;
  pageSize: number;
}): Promise<AppUserInvoicePage> {
  try {
    const config = await getAppBillingConfig(input.appId);
    return appUserPaymentMethodRequiresMerchantConnect(config)
      ? await listMerchantConnectInvoicesForAppUser({
          clientId: input.appId,
          externalUserId: input.externalUserId,
          page: input.page,
          pageSize: input.pageSize,
        })
      : await listOwnerRollupInvoices({
          clientId: input.appId,
          externalUserId: input.externalUserId,
          page: input.page,
          pageSize: input.pageSize,
        });
  } catch (err) {
    console.warn(
      "app-user-invoices: list failed",
      err instanceof Error ? err.message : String(err),
    );
    return {
      items: [],
      page: input.page,
      pageSize: input.pageSize,
      totalCount: 0,
    };
  }
}
