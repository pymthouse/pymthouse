import { isHostedAdminClientAvailable } from "./admin-client";
import { ensureStarterSubscriptionForAppUser } from "./starter-subscription";

/** Parse plan includedUsdMicros; invalid / empty / non-positive → 0n. */
export function starterGrantAmountUsdMicros(
  includedUsdMicros: string | null | undefined,
): bigint {
  const raw = includedUsdMicros?.trim() ?? "";
  if (!/^\d+$/.test(raw)) {
    return 0n;
  }
  return BigInt(raw);
}

/**
 * Ensure the end user has a Starter OpenMeter subscription.
 * Monthly included usage comes from the synced plan (`issueAfterReset` /
 * Konnect `discounts.usage`), not a one-time credit grant.
 */
export async function ensureTrialAllowanceForAppUser(input: {
  clientId: string;
  externalUserId: string;
}): Promise<void> {
  if (!isHostedAdminClientAvailable()) {
    return;
  }

  await ensureStarterSubscriptionForAppUser({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
}
