import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { plans } from "@/db/schema";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import { NETWORK_FEE_USD_MICROS_METER } from "@/lib/openmeter/constants";
import { buildOwnerMeterSubjects } from "@/lib/openmeter/customer-key";
import {
  ensureOpenMeterCustomer,
  ensureOpenMeterCustomerForAppUser,
  listOwnedPublicClientIds,
} from "@/lib/openmeter/customers";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";
import {
  getPrimaryOpenMeterSubscriptionForAppUser,
  resolveLocalPlanIdFromOpenMeterSubscription,
} from "@/lib/openmeter/subscription-read";
import { meterRowValueToBigInt } from "@/lib/openmeter/usage-read";

function parsePositiveMicros(raw: string | null | undefined): bigint | null {
  if (!raw?.trim()) return null;
  try {
    const value = BigInt(raw.trim());
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** Included usage discount for a local plan row (starter falls back to env default). */
export function includedDiscountUsdMicrosForPlan(
  plan: Pick<typeof plans.$inferSelect, "includedUsdMicros" | "isStarterDefault">,
): bigint | null {
  const fromPlan = parsePositiveMicros(plan.includedUsdMicros);
  if (fromPlan != null) return fromPlan;
  if (plan.isStarterDefault) {
    return parsePositiveMicros(defaultStarterIncludedUsdMicros());
  }
  return null;
}

async function querySubjectsUsedUsdMicros(
  subjects: string[],
  start: string,
  end: string,
): Promise<bigint> {
  if (!isHostedAdminClientAvailable()) {
    return 0n;
  }
  const unique = [...new Set(subjects.map((s) => s.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return 0n;
  }
  const client = getHostedAdminClient();
  try {
    const result = await client.meters.query(NETWORK_FEE_USD_MICROS_METER, {
      windowSize: "MONTH",
      from: new Date(start),
      to: new Date(end),
      subject: unique,
    });
    let used = 0n;
    for (const row of result.data || []) {
      used += meterRowValueToBigInt(row.value);
    }
    return used;
  } catch {
    return 0n;
  }
}

/**
 * Remaining plan usage discount for the current calendar month, for the
 * customer's primary active subscription. Zero when no discount or exhausted.
 */
export async function getRemainingPlanDiscountUsdMicros(input: {
  clientId: string;
  externalUserId: string;
}): Promise<bigint> {
  if (!isHostedAdminClientAvailable()) {
    return 0n;
  }

  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  const subscription = await getPrimaryOpenMeterSubscriptionForAppUser({
    clientId: identity.publicClientId,
    externalUserId: input.externalUserId,
  });
  if (!subscription) {
    return 0n;
  }

  const localPlanId = await resolveLocalPlanIdFromOpenMeterSubscription(
    identity.publicClientId,
    subscription,
  );

  let discount: bigint | null = null;
  if (localPlanId) {
    const rows = await db
      .select({
        includedUsdMicros: plans.includedUsdMicros,
        isStarterDefault: plans.isStarterDefault,
      })
      .from(plans)
      .where(eq(plans.id, localPlanId))
      .limit(1);
    if (rows[0]) {
      discount = includedDiscountUsdMicrosForPlan(rows[0]);
    }
  } else if (subscription.planKey?.toLowerCase().includes("starter")) {
    discount = parsePositiveMicros(defaultStarterIncludedUsdMicros());
  }

  if (discount == null || discount <= 0n) {
    return 0n;
  }

  const client = getHostedAdminClient();
  if (identity.isOwner && identity.ownerUserId) {
    await ensureOpenMeterCustomerForAppUser({
      client,
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
  } else {
    await ensureOpenMeterCustomer(client, identity.customerKey);
  }

  const cycle = calendarMonthBoundsUtc(new Date());
  const usageSubjects =
    identity.isOwner && identity.ownerUserId
      ? buildOwnerMeterSubjects(
          identity.ownerUserId,
          [
            identity.publicClientId,
            ...(await listOwnedPublicClientIds(identity.ownerUserId)),
          ],
        )
      : [identity.customerKey];

  const used = await querySubjectsUsedUsdMicros(
    usageSubjects,
    cycle.start,
    cycle.end,
  );

  return used >= discount ? 0n : discount - used;
}

/**
 * Spendable allowance for mint/signer gates: prepaid credits + remaining
 * plan usage discount for the current cycle.
 */
export async function getSpendableUsdMicros(input: {
  clientId: string;
  externalUserId: string;
}): Promise<string | null> {
  if (!isHostedAdminClientAvailable()) {
    return null;
  }

  const [credits, discountRemaining] = await Promise.all([
    getTrialCreditBalance({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    }),
    getRemainingPlanDiscountUsdMicros(input),
  ]);

  const creditMicros = BigInt(credits?.balanceUsdMicros ?? "0");
  return (creditMicros + discountRemaining).toString();
}
