import { findOrCreateAppEndUser } from "@/lib/billing";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import {
  ensureOpenMeterCustomerForAppUser,
  type OpenMeterCustomerIdentity,
} from "@/lib/openmeter/customers";
import { getTrialCreditBalance, type TrialCreditBalance } from "@/lib/openmeter/entitlements";
import { ensureStarterSubscriptionForAppUser } from "@/lib/openmeter/starter-subscription";
import { resolveOrCreateAppUser } from "@/lib/usage/record-signed-ticket";

export type ProvisionAppUserBillingResult = {
  appUserId: string;
  endUserId: string;
  externalUserId: string;
  allowance: TrialCreditBalance | null;
  starterSubscriptionCreated: boolean;
  starterSubscriptionReady: boolean;
};

/** Konnect/OpenMeter customer + subject attribution only (no DB plan/subscription). */
export async function ensureAppUserKonnectCustomer(input: {
  clientId: string;
  externalUserId: string;
  displayName?: string;
}): Promise<OpenMeterCustomerIdentity> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error(
      "OpenMeter is not configured (set OPENMETER_URL; OPENMETER_API_KEY for Konnect)",
    );
  }
  return ensureOpenMeterCustomerForAppUser({
    client: getHostedAdminClient(),
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    displayName: input.displayName,
  });
}

/**
 * Upsert app/end-user rows, ensure OpenMeter customer + Starter subscription,
 * and return included-usage balance for the active plan.
 */
export async function provisionAppUserBilling(input: {
  clientId: string;
  externalUserId: string;
}): Promise<ProvisionAppUserBillingResult> {
  const externalUserId = input.externalUserId.trim();
  const appUser = await resolveOrCreateAppUser({
    clientId: input.clientId,
    externalUserId,
  });
  const { id: endUserId } = await findOrCreateAppEndUser(input.clientId, externalUserId);

  const sub = await ensureStarterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId,
  });

  const allowance = await getTrialCreditBalance({
    clientId: input.clientId,
    externalUserId,
  });

  return {
    appUserId: appUser.id,
    endUserId,
    externalUserId,
    allowance,
    starterSubscriptionCreated: sub.created,
    starterSubscriptionReady: isHostedAdminClientAvailable()
      ? Boolean(sub.openmeterSubscriptionId)
      : true,
  };
}
