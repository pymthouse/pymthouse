import { randomUUID } from "node:crypto";
import type { GrantSource } from "@/lib/billing/types";
import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import { ensureStarterSubscriptionForAppUser } from "@/lib/openmeter/starter-subscription";
import { ensureTrialAllowanceForAppUser } from "@/lib/openmeter/trial-allowance";
import {
  getTrialCreditBalance,
  grantTrialCredits,
  type TrialCreditBalance,
} from "@/lib/openmeter/entitlements";
import {
  getHostedTrialOpenMeterClient,
  getTrialFeatureKeyForApp,
} from "@/lib/openmeter/client-factory";
import { getHostedOpenMeterUrl } from "@/lib/openmeter/constants";
import { ensureOpenMeterCustomer } from "@/lib/openmeter/customers";
import { createKonnectCreditGrant } from "@/lib/openmeter/konnect-credits";
import { shouldUseKonnectRoutes } from "@/lib/openmeter/route-mode";
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
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId,
  });
  const provisionExternalUserId = identity.isOwner
    ? (identity.ownerUserId as string)
    : externalUserId;

  await resolveOrCreateAppUser({
    clientId: identity.developerAppId,
    externalUserId: provisionExternalUserId,
  });
  await ensureStarterSubscriptionForAppUser({
    clientId: identity.developerAppId,
    externalUserId: provisionExternalUserId,
  });
  await ensureTrialAllowanceForAppUser({
    clientId: identity.developerAppId,
    externalUserId: provisionExternalUserId,
  });

  const featureKey =
    input.featureKey?.trim() || (await getTrialFeatureKeyForApp(identity.developerAppId));

  const customer = await ensureOpenMeterCustomer(client, identity.customerKey);

  const omApiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = shouldUseKonnectRoutes(getHostedOpenMeterUrl(), omApiKey);
  if (useKonnect) {
    await createKonnectCreditGrant({
      customerId: customer.id,
      amountUsdMicros: input.amountUsdMicros,
      name: `Manual allowance (${input.source})`,
      description: `Pymthouse allowance grant source=${input.source}`,
      featureKey,
      idempotencyKey: `manual:${customer.id}:${input.source}:${randomUUID()}`,
      apiKey: omApiKey,
    });
  } else {
    await grantTrialCredits({
      client,
      customerKey: identity.customerKey,
      featureKey,
      amountUsdMicros: input.amountUsdMicros,
    });
  }

  const balance = await getTrialCreditBalance({
    clientId: identity.publicClientId,
    externalUserId: provisionExternalUserId,
    featureKey,
  });

  return {
    externalUserId: provisionExternalUserId,
    source: input.source,
    grantedUsdMicros: input.amountUsdMicros.toString(),
    featureKey,
    balance,
  };
}
