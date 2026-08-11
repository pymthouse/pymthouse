/**
 * Chronological prepaid ledger for a merchant-mode app end-user.
 *
 * Mirrors the owner wallet ledger: OpenMeter has no per-event consumption
 * feed, so daily meter spend is synthesized into usage rows and walked
 * against the plan included allowance.
 */
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  buildLedgerEntries,
  type LedgerDailyUsageInput,
  type LedgerEntry,
  type LedgerGrantInput,
  type LedgerInvoiceInput,
} from "@/lib/billing/transactions-ledger";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { getHostedOpenMeterUrl } from "@/lib/openmeter/constants";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import { ensureOpenMeterCustomer } from "@/lib/openmeter/customers";
import { querySubjectDailyFeeUsage } from "@/lib/openmeter/daily-fee-usage";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import {
  decimalDollarsToUsdMicros,
  konnectGrantTimestamp,
  listKonnectCreditGrants,
} from "@/lib/openmeter/konnect-credits";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { shouldUseKonnectRoutes } from "@/lib/openmeter/route-mode";
import { getPlanDiscountUsdMicros } from "@/lib/openmeter/spendable-allowance";
import { sanitizeForLog } from "@/lib/sanitize-for-log";
import { listMerchantConnectInvoicesForAppUser } from "@/lib/stripe/merchant-connect";

const APP_USER_DAILY_USAGE_LOOKUP_BUDGET_MS = 3_000;

function withSoftTimeout<T>(input: {
  promise: Promise<T>;
  ms: number;
  fallback: T;
  label: string;
  onDegraded: () => void;
}): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`app-user-ledger: ${input.label} timed out after ${input.ms}ms`);
      input.onDegraded();
      resolve(input.fallback);
    }, input.ms);
    input.promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        console.warn(
          `app-user-ledger: ${input.label} failed`,
          sanitizeForLog(err instanceof Error ? err.message : String(err)),
        );
        input.onDegraded();
        resolve(input.fallback);
      },
    );
  });
}

async function listAppUserCreditGrants(input: {
  publicClientId: string;
  externalUserId: string;
  onDegraded?: () => void;
}): Promise<LedgerGrantInput[]> {
  if (!isHostedAdminClientAvailable()) {
    return [];
  }
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey)) {
    return [];
  }

  const client = getHostedAdminClient();
  const customerKey = buildOpenMeterCustomerKey(
    input.publicClientId,
    input.externalUserId,
  );
  try {
    const customer = await ensureOpenMeterCustomer(client, customerKey);
    const grants = await listKonnectCreditGrants({
      customerId: customer.id,
      apiKey,
    });
    return grants.flatMap((grant, index) => {
      let amountUsdMicros: string;
      try {
        amountUsdMicros = decimalDollarsToUsdMicros(grant.amount || "0").toString();
      } catch {
        return [];
      }
      return [
        {
          id: grant.id || grant.key || `grant-${index}`,
          amountUsdMicros,
          date: konnectGrantTimestamp(grant),
          name: grant.name?.trim() || null,
        },
      ];
    });
  } catch (err) {
    input.onDegraded?.();
    console.warn(
      "app-user-ledger: credit grant list failed",
      sanitizeForLog(customerKey),
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return [];
  }
}

function merchantHistoryToLedgerInvoices(
  items: Array<{
    id: string;
    number?: string;
    status: string;
    totalAmount: string;
    issuedAt?: string;
    periodStart?: string;
    periodEnd?: string;
    invoiceType: string;
    paymentMethodBrand?: string | null;
  }>,
): { grants: LedgerGrantInput[]; invoices: LedgerInvoiceInput[] } {
  const grants: LedgerGrantInput[] = [];
  const invoices: LedgerInvoiceInput[] = [];

  for (const item of items) {
    // One unparseable Stripe total drops its row rather than failing the whole
    // wallet request — the ledger already reports itself degraded on holes.
    let amountUsdMicros: string;
    try {
      amountUsdMicros = decimalDollarsToUsdMicros(item.totalAmount).toString();
    } catch {
      continue;
    }
    // Top-ups / ad-hoc payments fund prepaid credits — show as credit adds.
    // Stripe Connect invoices are settlement rows (no prepaid delta).
    if (item.invoiceType === "auto_topup" || item.invoiceType === "payment") {
      grants.push({
        id: item.id,
        amountUsdMicros,
        date: item.issuedAt ?? null,
        name: item.number?.trim() || "Prepaid credits added",
      });
      continue;
    }
    invoices.push({
      id: item.id,
      number: item.number,
      status: item.status,
      totalAmountUsdMicros: amountUsdMicros,
      issuedAt: item.issuedAt,
      periodStart: item.periodStart,
      periodEnd: item.periodEnd,
      invoiceType: "standard",
      paymentMethodBrand: item.paymentMethodBrand ?? null,
    });
  }

  return { grants, invoices };
}

export type AppUserBillingLedgerResult = {
  items: LedgerEntry[];
  /** True when a soft lookup failure may have left holes in the chain. */
  degraded: boolean;
};

type AppUserBillingLedgerDeps = {
  resolveOpenMeterMeterClientId: typeof resolveOpenMeterMeterClientId;
  listAppUserCreditGrants: typeof listAppUserCreditGrants;
  getPlanDiscountUsdMicros: typeof getPlanDiscountUsdMicros;
  getTrialCreditBalance: typeof getTrialCreditBalance;
  listMerchantConnectInvoicesForAppUser: typeof listMerchantConnectInvoicesForAppUser;
  isHostedAdminClientAvailable: typeof isHostedAdminClientAvailable;
  getHostedAdminClient: typeof getHostedAdminClient;
  querySubjectDailyFeeUsage: typeof querySubjectDailyFeeUsage;
};

const DEFAULT_APP_USER_BILLING_LEDGER_DEPS: AppUserBillingLedgerDeps = {
  resolveOpenMeterMeterClientId,
  listAppUserCreditGrants,
  getPlanDiscountUsdMicros,
  getTrialCreditBalance,
  listMerchantConnectInvoicesForAppUser,
  isHostedAdminClientAvailable,
  getHostedAdminClient,
  querySubjectDailyFeeUsage,
};

/**
 * Build the merchant end-user prepaid ledger (newest first).
 */
export async function loadAppUserBillingLedger(input: {
  /** developer_apps.id */
  appId: string;
  /** Public OAuth client id on the wire. */
  publicClientId: string;
  externalUserId: string;
}, deps: AppUserBillingLedgerDeps = DEFAULT_APP_USER_BILLING_LEDGER_DEPS): Promise<AppUserBillingLedgerResult> {
  const externalUserId = input.externalUserId.trim();
  const publicClientId = input.publicClientId.trim();
  if (!externalUserId || !publicClientId) {
    return { items: [], degraded: false };
  }

  let degraded = false;
  const cycle = calendarMonthBoundsUtc(new Date());
  const meterClientId = await deps.resolveOpenMeterMeterClientId(input.appId).catch(
    () => publicClientId,
  );
  const customerKey = buildOpenMeterCustomerKey(meterClientId, externalUserId);

  const [konnectGrants, discount, balance, history] = await Promise.all([
    deps.listAppUserCreditGrants({
      publicClientId: meterClientId,
      externalUserId,
      onDegraded: () => {
        degraded = true;
      },
    }).catch(() => {
      degraded = true;
      return [] as LedgerGrantInput[];
    }),
    deps.getPlanDiscountUsdMicros({
      clientId: publicClientId,
      externalUserId,
    }).catch(() => {
      degraded = true;
      return { totalUsdMicros: 0n, remainingUsdMicros: 0n };
    }),
    deps.getTrialCreditBalance({
      clientId: publicClientId,
      externalUserId,
    }).catch(() => {
      degraded = true;
      return null;
    }),
    deps.listMerchantConnectInvoicesForAppUser({
      clientId: input.appId,
      externalUserId,
      page: 1,
      pageSize: 50,
    }).catch(() => {
      degraded = true;
      return { items: [], page: 1, pageSize: 50, totalCount: 0 };
    }),
  ]);
  if (history.totalCount > history.items.length) {
    degraded = true;
  }

  const fromHistory = merchantHistoryToLedgerInvoices(history.items);
  // The two grant sources describe the same money and are never merged: a
  // settled Stripe top-up is credited through `grantAllowanceUsdMicros`, so it
  // already appears as a Konnect grant. Stripe payment rows are the fallback
  // for deployments not on Konnect routes, where `listAppUserCreditGrants`
  // returns nothing and top-ups would otherwise be invisible.
  const grants = konnectGrants.length > 0 ? konnectGrants : fromHistory.grants;

  let dailyUsage: LedgerDailyUsageInput[] = [];
  if (deps.isHostedAdminClientAvailable()) {
    dailyUsage = await withSoftTimeout({
      promise: deps.querySubjectDailyFeeUsage({
        client: deps.getHostedAdminClient(),
        subjects: [customerKey],
        start: cycle.start,
        end: cycle.end,
        logLabel: "app-user-ledger",
        onDegraded: () => {
          degraded = true;
        },
      }),
      ms: APP_USER_DAILY_USAGE_LOOKUP_BUDGET_MS,
      fallback: [] as LedgerDailyUsageInput[],
      label: "daily usage lookup",
      onDegraded: () => {
        degraded = true;
      },
    });
  } else {
    degraded = true;
  }

  const items = buildLedgerEntries({
    grants,
    dailyUsage,
    invoices: fromHistory.invoices,
    planIncludedUsdMicros: discount.totalUsdMicros.toString(),
    endingCreditBalanceUsdMicros: balance?.balanceUsdMicros ?? "0",
    inputsComplete: !degraded,
  });

  return { items, degraded };
}
