import { findOrCreateAppEndUser } from "@/lib/billing";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "@/lib/openmeter/admin-client";
import {
  ensureOpenMeterCustomerForAppUser,
  type OpenMeterCustomerIdentity,
} from "@/lib/openmeter/customers";
import { ensureStarterSubscriptionForAppUser } from "@/lib/openmeter/starter-subscription";
import { ensureTrialAllowanceForAppUser } from "@/lib/openmeter/trial-allowance";
import { resolveOrCreateAppUser } from "@/lib/usage/record-signed-ticket";

export type ProvisionAppUserBillingResult = {
  appUserId: string;
  endUserId: string;
  externalUserId: string;
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
 * Upsert app/end-user rows and ensure OpenMeter customer + Starter subscription.
 * Callers that need a live balance should use {@link getSpendableUsdMicros}.
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
  await ensureTrialAllowanceForAppUser({
    clientId: input.clientId,
    externalUserId,
  });

  return {
    appUserId: appUser.id,
    endUserId,
    externalUserId,
    starterSubscriptionCreated: sub.created,
    starterSubscriptionReady: isHostedAdminClientAvailable()
      ? Boolean(sub.openmeterSubscriptionId)
      : true,
  };
}
