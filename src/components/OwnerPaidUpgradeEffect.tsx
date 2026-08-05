"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Billing-page Upgrade entry: banner CTA to the dedicated checkout page.
 * Also surfaces a one-shot notice when returning from Stripe without ?upgrade=1
 * on the checkout URL (legacy /billing?pm=attached).
 */
export default function OwnerPaidUpgradePanel({
  eligibleForUpgrade,
}: Readonly<{
  hasPaymentMethod?: boolean;
  eligibleForUpgrade: boolean;
}>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pmAttached = searchParams.get("pm") === "attached";
  const [cardSavedNotice, setCardSavedNotice] = useState(false);

  useEffect(() => {
    if (!pmAttached) return;
    setCardSavedNotice(true);
    // Prefer the dedicated checkout page for the rest of Upgrade.
    if (eligibleForUpgrade) {
      router.replace("/billing/upgrade?pm=attached");
      return;
    }
    router.replace("/billing");
  }, [pmAttached, eligibleForUpgrade, router]);

  if (!eligibleForUpgrade) {
    return cardSavedNotice ? (
      <p className="mb-4 text-sm text-emerald-400/90">Payment method saved.</p>
    ) : null;
  }

  return (
    <div id="owner-paid-upgrade" className="mb-6 scroll-mt-6">
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-emerald-100">
              Upgrade from Sandbox Starter
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              Pick a monthly plan, link a payment method, then confirm. Overage
              invoices to your card after included usage.
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
