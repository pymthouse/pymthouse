import { eq, sql } from "drizzle-orm";

import { db } from "@/db/index";
import {
  apiKeys,
  appBillingOauthStates,
  appUsers,
  ownerBillingConfig,
  providerAdmins,
  sessions,
  users,
} from "@/db/schema";
import { formatUsdMicrosForDisplay } from "@/lib/billing/pay-per-use-threshold";
import { listOwnedPublicClientIds } from "@/lib/openmeter/customers";
import { getOwnerPrepaidCreditBalance } from "@/lib/openmeter/credit-allowance-summary";

export type AccountDeletionEligibility = {
  ownsApps: boolean;
  hasCredits: boolean;
  appCount: number;
  creditText: string | null;
};

export function ownerHasPrepaidCredits(balance: {
  hasAccess: boolean;
  balanceUsdMicros: string;
} | null): boolean {
  if (!balance) return false;
  if (balance.hasAccess) return true;
  try {
    return BigInt(balance.balanceUsdMicros) > 0n;
  } catch {
    return false;
  }
}

export function creditTextFromBalance(balance: {
  balanceUsdMicros: string;
} | null): string | null {
  if (!balance) return null;
  return `$${formatUsdMicrosForDisplay(balance.balanceUsdMicros)}`;
}

export function canPurgeAccountRow(ownsApps: boolean): boolean {
  return !ownsApps;
}

export function fundedOwnerBlocksReassign(hasCredits: boolean): boolean {
  return hasCredits;
}

export async function loadAccountDeletionEligibility(
  userId: string,
): Promise<AccountDeletionEligibility> {
  const trimmed = userId.trim();
  const [ownedClientIds, balance] = await Promise.all([
    listOwnedPublicClientIds(trimmed),
    getOwnerPrepaidCreditBalance(trimmed).catch(() => null),
  ]);
  return {
    ownsApps: ownedClientIds.length > 0,
    hasCredits: ownerHasPrepaidCredits(balance),
    appCount: ownedClientIds.length,
    creditText: ownerHasPrepaidCredits(balance)
      ? creditTextFromBalance(balance)
      : null,
  };
}

export async function purgeEmptyAccountUser(userId: string): Promise<void> {
  const trimmed = userId.trim();
  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.userId, trimmed));
    await tx.delete(providerAdmins).where(eq(providerAdmins.userId, trimmed));
    await tx.delete(appUsers).where(eq(appUsers.externalUserId, trimmed));
    await tx.delete(apiKeys).where(eq(apiKeys.userId, trimmed));
    await tx
      .delete(appBillingOauthStates)
      .where(eq(appBillingOauthStates.userId, trimmed));
    await tx
      .delete(ownerBillingConfig)
      .where(eq(ownerBillingConfig.ownerUserId, trimmed));
    await tx.execute(
      sql`UPDATE owner_billing_config SET updated_by = NULL WHERE updated_by = ${trimmed}`,
    );
    await tx.execute(
      sql`UPDATE platform_billing_settings SET updated_by = NULL WHERE updated_by = ${trimmed}`,
    );
    await tx.execute(
      sql`UPDATE admin_invites SET used_by = NULL WHERE used_by = ${trimmed}`,
    );
    await tx.execute(
      sql`DELETE FROM admin_invites WHERE created_by = ${trimmed}`,
    );
    await tx.execute(
      sql`UPDATE developer_apps SET reviewed_by = NULL WHERE reviewed_by = ${trimmed}`,
    );
    await tx.execute(
      sql`UPDATE subscriptions SET user_id = NULL WHERE user_id = ${trimmed}`,
    );
    await tx.delete(users).where(eq(users.id, trimmed));
  });
}
