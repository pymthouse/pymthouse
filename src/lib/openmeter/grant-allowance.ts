import type { GrantSource } from "@/lib/billing/types";
import { ensureStarterSubscriptionForAppUser } from "@/lib/openmeter/starter-subscription";
import { ensureTrialAllowanceForAppUser } from "@/lib/openmeter/trial-allowance";
import {
  getTrialCreditBalance,
  grantTrialCredits,
  type TrialCreditBalance,
} from "@/lib/openmeter/entitlements";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import {
  getHostedTrialOpenMeterClient,
  getTrialFeatureKeyForApp,
} from "@/lib/openmeter/client-factory";
import { ensureOpenMeterCustomer } from "@/lib/openmeter/customers";
import { resolveOrCreateAppUser } from "@/lib/usage/record-signed-ticket";

export async function grantAllowanceUsdMicros(input: {
  clientId: string;
  externalUserId: string;
  amountUsdMicros: bigint;
  source: GrantSource;
  featureKey?: string;
}): Promise<{
  externalUserId: string;
  source: GrantSource;
  grantedUsdMicros: string;
  featureKey: string;
  balance: TrialCreditBalance | null;
}> {
  const client = getHostedTrialOpenMeterClient();
  if (!client) {
    throw new Error("OpenMeter not configured");
  }

  const externalUserId = input.externalUserId.trim();
  await resolveOrCreateAppUser({ clientId: input.clientId, externalUserId });
  await ensureStarterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId,
  });
  await ensureTrialAllowanceForAppUser({
    clientId: input.clientId,
    externalUserId,
  });

  const customerKey = buildOpenMeterCustomerKey(input.clientId, externalUserId);
  const featureKey =
    input.featureKey?.trim() || (await getTrialFeatureKeyForApp(input.clientId));

  await ensureOpenMeterCustomer(client, customerKey);
  await grantTrialCredits({
    client,
    customerKey,
    featureKey,
    amountUsdMicros: input.amountUsdMicros,
  });

  const balance = await getTrialCreditBalance({
    clientId: input.clientId,
    externalUserId,
    featureKey,
  });

  return {
    externalUserId,
    source: input.source,
    grantedUsdMicros: input.amountUsdMicros.toString(),
    featureKey,
    balance,
  };
}
