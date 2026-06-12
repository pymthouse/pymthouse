import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";
import { isHostedAdminClientAvailable } from "./admin-client";
import {
  getHostedTrialOpenMeterClient,
  getTrialFeatureKeyForApp,
} from "./client-factory";
import { getHostedOpenMeterUrl } from "./constants";
import { buildOpenMeterCustomerKey } from "./customer-key";
import { getTrialCreditBalance, grantTrialCredits } from "./entitlements";
import { shouldUseKonnectRoutes } from "./route-mode";
import {
  ensureStarterPlanSynced,
  ensureStarterSubscriptionForAppUser,
} from "./starter-subscription";

/**
 * Ensure new and existing customers have starter trial credits.
 * Konnect: sync starter plan (discounts.usage) and ensure an active subscription exists.
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
