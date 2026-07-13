import { isHostedAdminClientAvailable, getHostedAdminClient } from "@/lib/openmeter/admin-client";
import { listTenantCustomerIds } from "@/lib/openmeter/customers";
import { getKonnectCreditBalance } from "@/lib/openmeter/konnect-credits";
import { getHostedOpenMeterUrl } from "@/lib/openmeter/constants";
import { shouldUseKonnectRoutes } from "@/lib/openmeter/route-mode";
import type { TrialCreditBalance } from "@/lib/openmeter/entitlements";

const CREDIT_LOOKUP_CONCURRENCY = 8;

export type CreditAllowanceSummary = TrialCreditBalance;

type PerClientCreditTotals = {
  balanceUsdMicros: bigint;
  lifetimeGrantedUsdMicros: bigint;
  consumedUsdMicros: bigint;
  succeededLookups: number;
};

function emptyPerClientTotals(): PerClientCreditTotals {
  return {
    balanceUsdMicros: 0n,
    lifetimeGrantedUsdMicros: 0n,
    consumedUsdMicros: 0n,
    succeededLookups: 0,
  };
}

function toCreditAllowanceSummary(
  totals: PerClientCreditTotals,
): CreditAllowanceSummary | null {
  if (totals.succeededLookups === 0) {
    return null;
  }
  return {
    hasAccess: totals.balanceUsdMicros > 0n,
    balanceUsdMicros: totals.balanceUsdMicros.toString(),
    lifetimeGrantedUsdMicros: totals.lifetimeGrantedUsdMicros.toString(),
    consumedUsdMicros: totals.consumedUsdMicros.toString(),
  };
}

/**
 * Prepaid credit ledgers keyed by public OIDC client_id (`app_…`).
 * Returns an empty object when hosted billing is unavailable.
 */
export async function getPrepaidCreditBalancesByClientId(
  publicClientIds: string[],
): Promise<Record<string, CreditAllowanceSummary>> {
  if (!isHostedAdminClientAvailable()) {
    return {};
  }

  const uniqueIds = [
    ...new Set(
      publicClientIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (uniqueIds.length === 0) {
    return {};
  }

  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey)) {
    return {};
  }

  const client = getHostedAdminClient();
  const listed = await Promise.all(
    uniqueIds.map(async (publicClientId) => {
      const customerIds = await listTenantCustomerIds(client, publicClientId).catch(
        (err) => {
          console.warn(
            "credit-allowance-summary: tenant customer list failed",
            publicClientId,
            err instanceof Error ? err.message : String(err),
          );
          return [] as string[];
        },
      );
      return { publicClientId, customerIds };
    }),
  );

  const byClient = new Map<string, PerClientCreditTotals>();
  for (const id of uniqueIds) {
    byClient.set(id, emptyPerClientTotals());
  }

  const customerToClient = new Map<string, string>();
  for (const { publicClientId, customerIds } of listed) {
    for (const customerId of customerIds) {
      customerToClient.set(customerId, publicClientId);
    }
  }

  const allCustomerIds = [...customerToClient.keys()];
  for (let i = 0; i < allCustomerIds.length; i += CREDIT_LOOKUP_CONCURRENCY) {
    const chunk = allCustomerIds.slice(i, i + CREDIT_LOOKUP_CONCURRENCY);
    const rows = await Promise.all(
      chunk.map(async (customerId) => {
        const balance = await getKonnectCreditBalance({
          customerId,
          apiKey,
        }).catch((err) => {
          console.warn(
            "credit-allowance-summary: balance lookup failed",
            customerId,
            err instanceof Error ? err.message : String(err),
          );
          return null;
        });
        return { customerId, balance };
      }),
    );
    for (const { customerId, balance } of rows) {
      if (!balance) continue;
      const publicClientId = customerToClient.get(customerId);
      if (!publicClientId) continue;
      const totals = byClient.get(publicClientId) ?? emptyPerClientTotals();
      totals.succeededLookups += 1;
      totals.balanceUsdMicros += balance.balanceUsdMicros;
      totals.lifetimeGrantedUsdMicros += balance.lifetimeGrantedUsdMicros;
      totals.consumedUsdMicros += balance.consumedUsdMicros;
      byClient.set(publicClientId, totals);
    }
  }

  const result: Record<string, CreditAllowanceSummary> = {};
  for (const [publicClientId, totals] of byClient) {
    const summary = toCreditAllowanceSummary(totals);
    if (summary) {
      result[publicClientId] = summary;
    }
  }
  return result;
}

/**
 * Sum prepaid credit ledgers for the given OpenMeter customer key prefixes
 * (`publicClientId:`), matching the remote-signer balance gate / auth_id tenants.
 * Returns null when hosted billing is unavailable, no customers exist, or every
 * balance lookup fails (so the UI does not show a false EXHAUSTED state).
 */
export async function sumPrepaidCreditBalancesForClientIds(
  publicClientIds: string[],
): Promise<CreditAllowanceSummary | null> {
  const byClient = await getPrepaidCreditBalancesByClientId(publicClientIds);
  const entries = Object.values(byClient);
  if (entries.length === 0) {
    return null;
  }

  let balanceUsdMicros = 0n;
  let lifetimeGrantedUsdMicros = 0n;
  let consumedUsdMicros = 0n;
  for (const row of entries) {
    balanceUsdMicros += BigInt(row.balanceUsdMicros);
    lifetimeGrantedUsdMicros += BigInt(row.lifetimeGrantedUsdMicros);
    consumedUsdMicros += BigInt(row.consumedUsdMicros);
  }

  return {
    hasAccess: balanceUsdMicros > 0n,
    balanceUsdMicros: balanceUsdMicros.toString(),
    lifetimeGrantedUsdMicros: lifetimeGrantedUsdMicros.toString(),
    consumedUsdMicros: consumedUsdMicros.toString(),
  };
}
