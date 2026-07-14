import { eq, inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { isHostedAdminClientAvailable, getHostedAdminClient } from "@/lib/openmeter/admin-client";
import { listTenantCustomers, ensureOpenMeterCustomer } from "@/lib/openmeter/customers";
import { getKonnectCreditBalance } from "@/lib/openmeter/konnect-credits";
import { getHostedOpenMeterUrl } from "@/lib/openmeter/constants";
import { buildOwnerCustomerKey, isOwnerCustomerKey } from "@/lib/openmeter/customer-key";
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

async function ownerIdsByPublicClientId(
  publicClientIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (publicClientIds.length === 0) {
    return map;
  }
  const rows = await db
    .select({
      publicClientId: oidcClients.clientId,
      ownerId: developerApps.ownerId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(inArray(oidcClients.clientId, publicClientIds));
  for (const row of rows) {
    const id = row.publicClientId?.trim();
    if (id && row.ownerId) {
      map.set(id, row.ownerId);
    }
  }
  return map;
}

function isLegacyOwnerAppCustomerKey(
  customerKey: string,
  publicClientId: string,
  ownerId: string | undefined,
): boolean {
  if (isOwnerCustomerKey(customerKey)) {
    return true;
  }
  if (!ownerId) {
    return false;
  }
  return customerKey === `${publicClientId}:${ownerId}`;
}

async function listEndUserCustomersForClient(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  publicClientId: string;
  ownerId: string | undefined;
}): Promise<Array<{ id: string; key: string }>> {
  const customers = await listTenantCustomers(
    input.client,
    input.publicClientId,
  ).catch((err) => {
    console.warn(
      "credit-allowance-summary: tenant customer list failed",
      input.publicClientId,
      err instanceof Error ? err.message : String(err),
    );
    return [] as Array<{ id: string; key: string }>;
  });
  return customers.filter(
    (row) =>
      !isLegacyOwnerAppCustomerKey(row.key, input.publicClientId, input.ownerId),
  );
}

async function applyBalanceChunk(input: {
  customerIds: string[];
  customerToClient: Map<string, string>;
  byClient: Map<string, PerClientCreditTotals>;
  apiKey: string | undefined;
}): Promise<void> {
  const rows = await Promise.all(
    input.customerIds.map(async (customerId) => {
      const balance = await getKonnectCreditBalance({
        customerId,
        apiKey: input.apiKey,
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
    const publicClientId = input.customerToClient.get(customerId);
    if (!publicClientId) continue;
    const totals = input.byClient.get(publicClientId) ?? emptyPerClientTotals();
    totals.succeededLookups += 1;
    totals.balanceUsdMicros += balance.balanceUsdMicros;
    totals.lifetimeGrantedUsdMicros += balance.lifetimeGrantedUsdMicros;
    totals.consumedUsdMicros += balance.consumedUsdMicros;
    input.byClient.set(publicClientId, totals);
  }
}

/**
 * Prepaid credit ledgers keyed by public OIDC client_id (`app_…`).
 * Sums end-user wallets only — excludes shared `owner:{users.id}` customers and
 * legacy per-app owner keys (`app_…:ownerId`).
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
  const owners = await ownerIdsByPublicClientId(uniqueIds);
  const listed = await Promise.all(
    uniqueIds.map(async (publicClientId) => ({
      publicClientId,
      customers: await listEndUserCustomersForClient({
        client,
        publicClientId,
        ownerId: owners.get(publicClientId),
      }),
    })),
  );

  const byClient = new Map<string, PerClientCreditTotals>();
  for (const id of uniqueIds) {
    byClient.set(id, emptyPerClientTotals());
  }

  const customerToClient = new Map<string, string>();
  for (const { publicClientId, customers } of listed) {
    for (const row of customers) {
      customerToClient.set(row.id, publicClientId);
    }
  }

  const allCustomerIds = [...customerToClient.keys()];
  for (let i = 0; i < allCustomerIds.length; i += CREDIT_LOOKUP_CONCURRENCY) {
    await applyBalanceChunk({
      customerIds: allCustomerIds.slice(i, i + CREDIT_LOOKUP_CONCURRENCY),
      customerToClient,
      byClient,
      apiKey,
    });
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
 * Single shared prepaid wallet for an app owner (`owner:{users.id}`).
 */
export async function getOwnerPrepaidCreditBalance(
  ownerUserId: string,
): Promise<CreditAllowanceSummary | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }
  const trimmed = ownerUserId.trim();
  if (!trimmed) {
    return null;
  }

  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey)) {
    return null;
  }

  const client = getHostedAdminClient();
  const customerKey = buildOwnerCustomerKey(trimmed);
  try {
    const customer = await ensureOpenMeterCustomer(client, customerKey);
    const balance = await getKonnectCreditBalance({
      customerId: customer.id,
      apiKey,
    });
    if (!balance) {
      return null;
    }
    // Treat an all-zero ledger as "no prepaid wallet" so UI empty-states render
    // instead of a blank AllowanceStrip (which hides when granted+remaining are 0).
    if (balance.balanceUsdMicros <= 0n && balance.lifetimeGrantedUsdMicros <= 0n) {
      return null;
    }
    return {
      hasAccess: balance.balanceUsdMicros > 0n,
      balanceUsdMicros: balance.balanceUsdMicros.toString(),
      lifetimeGrantedUsdMicros: balance.lifetimeGrantedUsdMicros.toString(),
      consumedUsdMicros: balance.consumedUsdMicros.toString(),
    };
  } catch (err) {
    console.warn(
      "credit-allowance-summary: owner balance lookup failed",
      trimmed,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Sum prepaid credit ledgers for end-users under the given apps
 * (excludes shared owner wallets). Returns null when unavailable.
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
