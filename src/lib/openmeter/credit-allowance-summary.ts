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
 * Returns null when hosted billing is unavailable, no customers exist, or every
 * balance lookup fails (so the UI does not show a false EXHAUSTED state).
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
  const listed = await Promise.all(
    uniqueIds.map((publicClientId) =>
      listTenantCustomerIds(client, publicClientId).catch((err) => {
        console.warn(
          "credit-allowance-summary: tenant customer list failed",
          publicClientId,
          err instanceof Error ? err.message : String(err),
        );
        return [] as string[];
      }),
    ),
  );
  const customerIds = listed.flat();
  if (customerIds.length === 0) {
    return null;
  }

  let balanceUsdMicros = 0n;
  let lifetimeGrantedUsdMicros = 0n;
  let consumedUsdMicros = 0n;
  let succeededLookups = 0;

  for (let i = 0; i < customerIds.length; i += CREDIT_LOOKUP_CONCURRENCY) {
    const chunk = customerIds.slice(i, i + CREDIT_LOOKUP_CONCURRENCY);
    const rows = await Promise.all(
      chunk.map((customerId) =>
        getKonnectCreditBalance({
          customerId,
          apiKey,
        }).catch((err) => {
          console.warn(
            "credit-allowance-summary: balance lookup failed",
            customerId,
            err instanceof Error ? err.message : String(err),
          );
          return null;
        }),
      ),
    );
    for (const row of rows) {
      if (!row) continue;
      succeededLookups += 1;
      balanceUsdMicros += row.balanceUsdMicros;
      lifetimeGrantedUsdMicros += row.lifetimeGrantedUsdMicros;
      consumedUsdMicros += row.consumedUsdMicros;
    }
  }

  if (succeededLookups === 0) {
    return null;
  }

  return {
    hasAccess: balanceUsdMicros > 0n,
    balanceUsdMicros: balanceUsdMicros.toString(),
    lifetimeGrantedUsdMicros: lifetimeGrantedUsdMicros.toString(),
    consumedUsdMicros: consumedUsdMicros.toString(),
  };
}
