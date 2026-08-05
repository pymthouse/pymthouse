"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Billing-page plan CTA: Upgrade from Starter, or Change plan when already Paid.
 * Also surfaces a one-shot notice when returning from Stripe without ?upgrade=1
 * on the checkout URL (legacy /billing?pm=attached).
 */
export default function OwnerPaidUpgradePanel({
  eligibleForUpgrade,
  canChangePlan = false,
  starterPlanName = "Owner Sandbox Starter",
  currentPlanName,
}: Readonly<{
  hasPaymentMethod?: boolean;
  eligibleForUpgrade: boolean;
  canChangePlan?: boolean;
  starterPlanName?: string;
  currentPlanName?: string | null;
}>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pmAttached = searchParams.get("pm") === "attached";
  const [cardSavedNotice, setCardSavedNotice] = useState(false);

  useEffect(() => {
    if (!pmAttached) return;
    setCardSavedNotice(true);
    // Prefer the dedicated checkout page for the rest of Upgrade / Change.
    if (eligibleForUpgrade || canChangePlan) {
      router.replace("/billing/upgrade?pm=attached");
      return;
    }
    router.replace("/billing");
  }, [pmAttached, eligibleForUpgrade, canChangePlan, router]);

  if (eligibleForUpgrade) {
    return (
      <div id="owner-paid-upgrade" className="mb-6 scroll-mt-6">
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-emerald-100">
                Upgrade from {starterPlanName}
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                Pick a monthly plan, link a payment method, then confirm. That
                method pays the plan fee and overage after included usage.
              </p>
            </div>
            <Link
              href="/billing/upgrade"
              className="shrink-0 rounded-md bg-emerald-500/20 px-4 py-2 text-center text-sm text-emerald-200 hover:bg-emerald-500/30"
            >
              Upgrade
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (canChangePlan) {
    return (
      <div id="owner-paid-change-plan" className="mb-6 scroll-mt-6">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-100">
                Change plan
                {currentPlanName ? (
                  <span className="font-normal text-zinc-500">
                    {" "}
                    · on {currentPlanName}
                  </span>
                ) : null}
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                Switch to another monthly plan anytime. Confirming starts a new
                billing cycle and charges that plan&apos;s fee.
              </p>
            </div>
            <Link
              href="/billing/upgrade"
              className="shrink-0 rounded-md border border-white/10 bg-white/5 px-4 py-2 text-center text-sm text-zinc-200 hover:bg-white/10"
            >
              Change plan
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return cardSavedNotice ? (
    <p className="mb-4 text-sm text-emerald-400/90">Payment method saved.</p>
  ) : null;
}
