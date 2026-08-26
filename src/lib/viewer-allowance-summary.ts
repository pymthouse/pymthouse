import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";
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
  const starter = await resolvePlatformOwnerStarterIncludedUsdMicros();
  if (owned.length === 0) {
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
  const starterMicros = BigInt(starter);

  await Promise.all(
    owned.map(async (app) => {
      const balance = await getTrialCreditBalance({
        clientId: app.id,
        externalUserId: userId,
      });
      if (!balance) {
        remaining += starterMicros;
        granted += starterMicros;
        return;
      }
      try {
        const appRemaining = BigInt(balance.balanceUsdMicros || "0");
        const appGranted = BigInt(balance.lifetimeGrantedUsdMicros || "0");
        const appConsumed = BigInt(balance.consumedUsdMicros || "0");

        remaining += appRemaining;
        granted += appGranted;
        consumed += appConsumed;
        if (appGranted > starterMicros) {
          hasPrepaidCredits = true;
        }
      } catch {
        remaining += starterMicros;
        granted += starterMicros;
      }
    }),
  );

  if (granted <= 0n) {
    granted = starterMicros;
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
