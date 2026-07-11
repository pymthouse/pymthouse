import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";
import { isHostedAdminClientAvailable } from "./admin-client";
import {
  getHostedTrialOpenMeterClient,
  getTrialFeatureKeyForApp,
} from "./client-factory";
import { getHostedOpenMeterUrl } from "./constants";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { ensureOpenMeterCustomer } from "./customers";
import { getTrialCreditBalance, grantTrialCredits } from "./entitlements";
import { createKonnectCreditGrant } from "./konnect-credits";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  ensureStarterPlanSynced,
  ensureStarterSubscriptionForAppUser,
} from "./starter-subscription";

/**
 * Ensure new and existing customers have starter trial credits.
 * Konnect: sync starter plan + subscription, then POST /credits/grants.
 * Self-hosted: explicit entitlement grant via OpenMeter grants API.
 */
export async function ensureTrialAllowanceForAppUser(input: {
  clientId: string;
  externalUserId: string;
}): Promise<void> {
  if (!isHostedAdminClientAvailable()) {
    return;
  }

  const balance = await getTrialCreditBalance({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  if (balance?.hasAccess) {
    return;
  }

  const amount = BigInt(defaultStarterIncludedUsdMicros());
  if (amount <= 0n) {
    return;
  }

  const omApiKey = process.env.OPENMETER_API_KEY?.trim();
  const useKonnect = shouldUseKonnectRoutes(getHostedOpenMeterUrl(), omApiKey);

  if (useKonnect) {
    await ensureStarterPlanSynced(input.clientId);
    await ensureStarterSubscriptionForAppUser({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });

    const trialClient = getHostedTrialOpenMeterClient();
    if (!trialClient) {
      return;
    }
    const customerKey = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
    const customer = await ensureOpenMeterCustomer(trialClient, customerKey);
    const featureKey = await getTrialFeatureKeyForApp(input.clientId);
    await createKonnectCreditGrant({
      customerId: customer.id,
      amountUsdMicros: amount,
      name: "Starter trial credits",
      description: "Pymthouse starter allowance",
      featureKey,
      idempotencyKey: `starter:${customer.id}:${featureKey}`,
      apiKey: omApiKey,
    });
    return;
  }

  const trialClient = getHostedTrialOpenMeterClient();
  if (!trialClient) {
    return;
  }

  await ensureStarterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  const customerKey = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
  const featureKey = await getTrialFeatureKeyForApp(input.clientId);
  await grantTrialCredits({
    client: trialClient,
    customerKey,
    featureKey,
    amountUsdMicros: amount,
  });
}
