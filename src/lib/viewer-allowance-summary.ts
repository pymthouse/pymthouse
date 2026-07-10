import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";
import { listUserAccessibleApps } from "@/lib/user-apps";

export type ViewerAllowanceSummary = {
  /** Remaining spendable balance (trial leftover + prepaid credits), USD micros. */
  remainingUsdMicros: string;
  /** Lifetime granted (starter included + prepaid credits), USD micros. */
  grantedUsdMicros: string;
  /** Network fees consumed against trial this period, USD micros. */
  consumedUsdMicros: string;
  /** True when any owned app has Konnect prepaid credits. */
  hasPrepaidCredits: boolean;
};

/**
 * Aggregate OpenMeter allowance for the signed-in viewer across apps they own.
 * Includes Konnect prepaid credit grants (MoonPay on-ramp) on top of Starter.
 */
export async function getViewerAllowanceSummary(): Promise<ViewerAllowanceSummary | null> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id?.trim();
  if (!userId) {
    return null;
  }

  const apps = await listUserAccessibleApps(userId);
  const owned = apps.filter((app) => app.isOwner && app.id);
  if (owned.length === 0) {
    const starter = defaultStarterIncludedUsdMicros();
    return {
      remainingUsdMicros: starter,
      grantedUsdMicros: starter,
      consumedUsdMicros: "0",
      hasPrepaidCredits: false,
    };
  }

  let remaining = 0n;
  let granted = 0n;
  let consumed = 0n;
  let hasPrepaidCredits = false;
  const starter = BigInt(defaultStarterIncludedUsdMicros());

  await Promise.all(
    owned.map(async (app) => {
      const balance = await getTrialCreditBalance({
        clientId: app.id,
        externalUserId: userId,
      });
      if (!balance) {
        remaining += starter;
        granted += starter;
        return;
      }
      try {
        remaining += BigInt(balance.balanceUsdMicros || "0");
        granted += BigInt(balance.lifetimeGrantedUsdMicros || "0");
        consumed += BigInt(balance.consumedUsdMicros || "0");
        if (BigInt(balance.lifetimeGrantedUsdMicros || "0") > starter) {
          hasPrepaidCredits = true;
        }
      } catch {
        remaining += starter;
        granted += starter;
      }
    }),
  );

  if (granted <= 0n) {
    granted = starter;
  }
  if (remaining < 0n) {
    remaining = 0n;
  }

  return {
    remainingUsdMicros: remaining.toString(),
    grantedUsdMicros: granted.toString(),
    consumedUsdMicros: consumed.toString(),
    hasPrepaidCredits,
  };
}
