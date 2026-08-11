/**
 * Chronological prepaid ledger for a merchant-mode app end-user.
 *
 * Mirrors the owner wallet ledger: OpenMeter has no per-event consumption
 * feed, so daily meter spend is synthesized into usage rows and walked
 * against the plan included allowance.
 */
import type { OpenMeter } from "@openmeter/sdk";

import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  buildLedgerEntries,
  type LedgerEntry,
  type LedgerGrantInput,
  type LedgerInvoiceInput,
} from "@/lib/billing/transactions-ledger";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { NETWORK_FEE_USD_MICROS_METER, getHostedOpenMeterUrl } from "@/lib/openmeter/constants";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import { ensureOpenMeterCustomer } from "@/lib/openmeter/customers";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import {
  decimalDollarsToUsdMicros,
  konnectGrantTimestamp,
  listKonnectCreditGrants,
} from "@/lib/openmeter/konnect-credits";
import { shouldUseKonnectRoutes } from "@/lib/openmeter/route-mode";
import { getPlanDiscountUsdMicros } from "@/lib/openmeter/spendable-allowance";
import {
  dateKeyFromMeterWindow,
  meterRowValueToBigInt,
} from "@/lib/openmeter/usage-read";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { listMerchantConnectInvoicesForAppUser } from "@/lib/stripe/merchant-connect";

async function querySubjectDailyUsage(input: {
  client: OpenMeter;
  subjects: string[];
  start: string;
  end: string;
}): Promise<Array<{ date: string; usedUsdMicros: string }>> {
  const subjects = [...new Set(input.subjects.map((s) => s.trim()).filter(Boolean))];
  if (subjects.length === 0) {
    return [];
  }

  try {
    const feeResult = await input.client.meters.query(NETWORK_FEE_USD_MICROS_METER, {
      windowSize: "DAY" as const,
      from: new Date(input.start),
      to: new Date(input.end),
      subject: subjects,
    });

    const byDay = new Map<string, bigint>();
    for (const row of feeResult.data || []) {
      const dateKey = dateKeyFromMeterWindow(row);
      if (!dateKey) continue;
      byDay.set(dateKey, (byDay.get(dateKey) ?? 0n) + meterRowValueToBigInt(row.value));
    }

    return [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, used]) => ({ date, usedUsdMicros: used.toString() }));
  } catch (err) {
    console.warn(
      "app-user-ledger: daily meter query failed",
      subjects.join(","),
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

async function listAppUserCreditGrants(input: {
  publicClientId: string;
  externalUserId: string;
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
    console.warn(
      "app-user-ledger: credit grant list failed",
      customerKey,
      err instanceof Error ? err.message : String(err),
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
  }>,
): { grants: LedgerGrantInput[]; invoices: LedgerInvoiceInput[] } {
  const grants: LedgerGrantInput[] = [];
  const invoices: LedgerInvoiceInput[] = [];

  for (const item of items) {
    const amountUsdMicros = decimalDollarsToUsdMicros(item.totalAmount).toString();
    // Top-ups / ad-hoc payments fund prepaid credits — show as credit adds.
    // Stripe Connect invoices are settlement rows (no prepaid delta).
    if (
      item.invoiceType === "auto_topup" ||
      item.invoiceType === "payment"
    ) {
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
    });
  }

  return { grants, invoices };
}

export type AppUserBillingLedgerResult = {
  items: LedgerEntry[];
  /** True when a soft lookup failure may have left holes in the chain. */
  degraded: boolean;
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
}): Promise<AppUserBillingLedgerResult> {
  const externalUserId = input.externalUserId.trim();
  const publicClientId = input.publicClientId.trim();
  if (!externalUserId || !publicClientId) {
    return { items: [], degraded: false };
  }

  let degraded = false;
  const cycle = calendarMonthBoundsUtc(new Date());
  const meterClientId = await resolveOpenMeterMeterClientId(input.appId).catch(
    () => publicClientId,
  );
  const customerKey = buildOpenMeterCustomerKey(meterClientId, externalUserId);

  const [konnectGrants, discount, balance, history] = await Promise.all([
    listAppUserCreditGrants({
      publicClientId: meterClientId,
      externalUserId,
    }).catch(() => {
      degraded = true;
      return [] as LedgerGrantInput[];
    }),
    getPlanDiscountUsdMicros({
      clientId: publicClientId,
      externalUserId,
    }).catch(() => {
      degraded = true;
      return { totalUsdMicros: 0n, remainingUsdMicros: 0n };
    }),
    getTrialCreditBalance({
      clientId: publicClientId,
      externalUserId,
    }).catch(() => {
      degraded = true;
      return null;
    }),
    listMerchantConnectInvoicesForAppUser({
      clientId: input.appId,
      externalUserId,
      page: 1,
      pageSize: 50,
    }).catch(() => {
      degraded = true;
      return { items: [], page: 1, pageSize: 50, totalCount: 0 };
    }),
  ]);

  const fromHistory = merchantHistoryToLedgerInvoices(history.items);
  // Prefer Konnect grants when present; fall back to Stripe payment rows so
  // top-ups still appear when grant timestamps are missing.
  const grants =
    konnectGrants.length > 0 ? konnectGrants : fromHistory.grants;

  let dailyUsage: Array<{ date: string; usedUsdMicros: string }> = [];
  if (isHostedAdminClientAvailable()) {
    dailyUsage = await querySubjectDailyUsage({
      client: getHostedAdminClient(),
      subjects: [customerKey],
      start: cycle.start,
      end: cycle.end,
    }).catch(() => {
      degraded = true;
      return [];
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
