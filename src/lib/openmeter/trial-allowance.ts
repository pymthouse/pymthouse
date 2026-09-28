import { resolveOpenMeterBillingIdentity } from "@/lib/openmeter/billing-identity";
import { isHostedAdminClientAvailable } from "./admin-client";
import {
  ensureStarterPlanSynced,
  ensureStarterSubscriptionForAppUser,
} from "./starter-subscription";

/**
 * Ensure the customer has a synced Starter plan subscription.
 *
 * Included free usage comes from the plan rate-card `discounts.usage`
 * (amount from `plans.includedUsdMicros`, seeded by `OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS`),
 * not from prepaid credit grants. Manual top-ups still use `grantAllowanceUsdMicros`.
 *
 * App owners share one `owner:{users.id}` customer across owned apps.
 */
export async function ensureTrialAllowanceForAppUser(input: {
  clientId: string;
  externalUserId: string;
  /**
   * Force merchant `eu_` / `sbx_eu_` from the Connect payment plane when the
   * app's active stripeLivemode may already have switched.
   */
  stripeLivemode?: boolean;
  /**
   * Force merchant `eu_` / `sbx_eu_` when settling a Connect charge whose app
   * may already have switched to `owner_rollup`.
   */
  billingMode?: "owner_rollup" | "merchant";
}): Promise<void> {
  if (!isHostedAdminClientAvailable()) {
    return;
  }

  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
    stripeLivemode: input.stripeLivemode,
    billingMode: input.billingMode,
  });

  await ensureStarterPlanSynced(identity.developerAppId);
  await ensureStarterSubscriptionForAppUser({
    clientId: identity.developerAppId,
    externalUserId: input.externalUserId,
    stripeLivemode: input.stripeLivemode,
    billingMode: input.billingMode,
  });
}
