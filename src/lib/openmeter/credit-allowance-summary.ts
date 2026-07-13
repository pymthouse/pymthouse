import { isHostedAdminClientAvailable, getHostedAdminClient } from "@/lib/openmeter/admin-client";
import { listTenantCustomerIds } from "@/lib/openmeter/customers";
import { getKonnectCreditBalance } from "@/lib/openmeter/konnect-credits";
import { getHostedOpenMeterUrl } from "@/lib/openmeter/constants";
import { shouldUseKonnectRoutes } from "@/lib/openmeter/route-mode";
import type { TrialCreditBalance } from "@/lib/openmeter/entitlements";

const CREDIT_LOOKUP_CONCURRENCY = 8;

export type CreditAllowanceSummary = TrialCreditBalance;

/**
 * Sum prepaid credit ledgers for the given OpenMeter customer key prefixes
 * (`publicClientId:`), matching the remote-signer balance gate / auth_id tenants.
 * Returns null when hosted billing is unavailable or no customers exist.
 */
export async function sumPrepaidCreditBalancesForClientIds(
  publicClientIds: string[],
): Promise<CreditAllowanceSummary | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }

  const uniqueIds = [
    ...new Set(
      publicClientIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (uniqueIds.length === 0) {
    return null;
  }

  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!shouldUseKonnectRoutes(getHostedOpenMeterUrl(), apiKey)) {
    return null;
  }

  const client = getHostedAdminClient();
  const customerIds: string[] = [];
  for (const publicClientId of uniqueIds) {
    const ids = await listTenantCustomerIds(client, publicClientId);
    customerIds.push(...ids);
  }
  if (customerIds.length === 0) {
    return null;
  }

  let balanceUsdMicros = 0n;
  let lifetimeGrantedUsdMicros = 0n;
  let consumedUsdMicros = 0n;

  for (let i = 0; i < customerIds.length; i += CREDIT_LOOKUP_CONCURRENCY) {
    const chunk = customerIds.slice(i, i + CREDIT_LOOKUP_CONCURRENCY);
    const rows = await Promise.all(
      chunk.map((customerId) =>
        getKonnectCreditBalance({
          customerId,
          apiKey,
        }).catch(() => null),
      ),
    );
    for (const row of rows) {
      if (!row) continue;
      balanceUsdMicros += row.balanceUsdMicros;
      lifetimeGrantedUsdMicros += row.lifetimeGrantedUsdMicros;
      consumedUsdMicros += row.consumedUsdMicros;
    }
  }

  return {
    hasAccess: balanceUsdMicros > 0n,
    balanceUsdMicros: balanceUsdMicros.toString(),
    lifetimeGrantedUsdMicros: lifetimeGrantedUsdMicros.toString(),
    consumedUsdMicros: consumedUsdMicros.toString(),
  };
}
