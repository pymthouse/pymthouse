/**
 * Resolve unbilled debt (USD micros) for soft-negative / lead auto-top-up.
 * Prefer gathering invoice totals; fall back to calendar-month meter usage.
 */
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import { getAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { NETWORK_FEE_USD_MICROS_METER } from "@/lib/openmeter/constants";
import { buildOwnerMeterSubjects } from "@/lib/openmeter/customer-key";
import {
  ensureOpenMeterCustomer,
  ensureOwnerCustomer,
  findOpenMeterCustomerByKey,
  listOwnedPublicClientIds,
} from "@/lib/openmeter/customers";
import { decimalDollarsToUsdMicros } from "@/lib/openmeter/konnect-credits";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { getProviderApp } from "@/lib/provider-apps";
import {
  ceilExactUsdMicrosSum,
  meterRowValueToNumber,
} from "@/lib/openmeter/usage-read";

/** Parse OpenMeter gathering invoice `totals.total` into USD micros. */
export function gatheringTotalUsdMicros(total: unknown): bigint | null {
  if (total == null) return null;
  try {
    if (typeof total === "number" && Number.isFinite(total)) {
      return decimalDollarsToUsdMicros(String(total));
    }
    if (typeof total === "string") {
      const trimmed = total.trim();
      if (!trimmed) return null;
      if (/^-?\d+$/.test(trimmed) && trimmed.length > 8) {
        return BigInt(trimmed);
      }
      return decimalDollarsToUsdMicros(trimmed);
    }
  } catch {
    return null;
  }
  return null;
}

async function maxGatheringDebtUsdMicros(
  customerId: string,
): Promise<bigint | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }
  try {
    const client = getHostedAdminClient();
    const listed = await client.billing.invoices.list({
      customers: [customerId],
      page: 1,
      pageSize: 20,
      order: "DESC",
      orderBy: "createdAt",
    });
    let max = 0n;
    let found = false;
    for (const inv of listed?.items ?? []) {
      if (String(inv.status ?? "").toLowerCase() !== "gathering") {
        continue;
      }
      const micros = gatheringTotalUsdMicros(inv.totals?.total);
      if (micros == null) continue;
      found = true;
      if (micros > max) max = micros;
    }
    return found ? max : null;
  } catch {
    return null;
  }
}

async function periodMeterDebtUsdMicros(subjects: string[]): Promise<bigint> {
  if (!isHostedAdminClientAvailable()) {
    return 0n;
  }
  const unique = [...new Set(subjects.map((s) => s.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return 0n;
  }
  const cycle = calendarMonthBoundsUtc(new Date());
  try {
    const client = getHostedAdminClient();
    const result = await client.meters.query(NETWORK_FEE_USD_MICROS_METER, {
      windowSize: "MONTH",
      from: new Date(cycle.start),
      to: new Date(cycle.end),
      subject: unique,
    });
    let usedExact = 0;
    for (const row of result.data || []) {
      usedExact += meterRowValueToNumber(row.value);
    }
    return ceilExactUsdMicrosSum(usedExact);
  } catch {
    return 0n;
  }
}

/**
 * Unbilled debt for soft-negative gating. Gathering total when present,
 * else period network-fee meter sum for the billing subjects.
 */
export async function getUnbilledDebtUsdMicros(input: {
  clientId: string;
  externalUserId: string;
}): Promise<bigint> {
  if (!isHostedAdminClientAvailable()) {
    return 0n;
  }
  const clientId = input.clientId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!clientId || !externalUserId) {
    return 0n;
  }

  const identity = await resolveOpenMeterBillingIdentity({
    clientId,
    externalUserId,
  });
  const client = getHostedAdminClient();
  const app = await getProviderApp(clientId);
  const appId = app?.id?.trim() || identity.developerAppId;
  const billingConfig = await getAppBillingConfig(appId);
  const merchant = billingConfig?.billingMode === "merchant";

  let customerId: string | null = null;
  let meterSubjects: string[] = [];

  if (identity.isOwner && identity.ownerUserId) {
    const publicClientIds = await listOwnedPublicClientIds(identity.ownerUserId);
    const ownerCustomer = await ensureOwnerCustomer(
      client,
      identity.ownerUserId,
      publicClientIds,
    );
    customerId = ownerCustomer.id?.trim() || null;
    meterSubjects = buildOwnerMeterSubjects(identity.ownerUserId, [
      identity.publicClientId,
      ...publicClientIds,
    ]);
  } else if (merchant) {
    const publicClientId = await resolveOpenMeterMeterClientId(appId);
    const key = `${publicClientId}:${externalUserId}`;
    const customer = await findOpenMeterCustomerByKey(client, key);
    customerId = customer?.id?.trim() || null;
    meterSubjects = [key];
  } else {
    await ensureOpenMeterCustomer(client, identity.customerKey);
    const customer = await findOpenMeterCustomerByKey(
      client,
      identity.customerKey,
    );
    customerId = customer?.id?.trim() || null;
    meterSubjects = [identity.customerKey];
  }

  if (customerId) {
    const gathering = await maxGatheringDebtUsdMicros(customerId);
    if (gathering != null) {
      return gathering;
    }
  }
  return periodMeterDebtUsdMicros(meterSubjects);
}
