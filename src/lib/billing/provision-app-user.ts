import { findOrCreateAppEndUser } from "@/lib/billing";
import { getTrialCreditBalance, type TrialCreditBalance } from "@/lib/openmeter/entitlements";
import { ensureStarterSubscriptionForAppUser } from "@/lib/openmeter/starter-subscription";
import { ensureTrialAllowanceForAppUser } from "@/lib/openmeter/trial-allowance";
import { resolveOrCreateAppUser } from "@/lib/usage/record-signed-ticket";

export type ProvisionAppUserBillingResult = {
  appUserId: string;
  endUserId: string;
  externalUserId: string;
  allowance: TrialCreditBalance | null;
  starterSubscriptionCreated: boolean;
};

/**
 * Upsert app/end-user rows, ensure OpenMeter customer + Starter subscription,
 * and return subscription allowance balance (network_spend entitlement).
 */
export async function provisionAppUserBilling(input: {
  clientId: string;
  externalUserId: string;
  walletAddress?: string;
  turnkeySubOrgId?: string;
  turnkeyUserId?: string;
}): Promise<ProvisionAppUserBillingResult> {
  const externalUserId = input.externalUserId.trim();
  const appUser = await resolveOrCreateAppUser({
    clientId: input.clientId,
    externalUserId,
  });
  const { id: endUserId } = await findOrCreateAppEndUser(input.clientId, externalUserId, {
    walletAddress: input.walletAddress,
    turnkeySubOrgId: input.turnkeySubOrgId,
    turnkeyUserId: input.turnkeyUserId,
  });

  const sub = await ensureStarterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId,
  });
  await ensureTrialAllowanceForAppUser({
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
  };
}
