"use client";

import { useState } from "react";

import { OPEN_OWNER_UPGRADE_EVENT } from "@/components/OwnerPaidUpgradeEffect";
import { stripeCheckoutRedirectUrl } from "@/lib/openmeter/stripe-checkout-session";

/**
 * Owner billing header action for payment methods.
 * On Sandbox Starter without a card, the primary CTA is Upgrade (not attach-card).
 * Updating an existing card stays a direct Stripe Checkout setup.
 */
export default function OwnerPaymentMethodButton({
  hasPaymentMethod = false,
  upgradeFirst = false,
}: Readonly<{
  hasPaymentMethod?: boolean;
  /** Sandbox Starter + no card: open Upgrade flow instead of Stripe setup. */
  upgradeFirst?: boolean;
}>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openUpgrade() {
    window.dispatchEvent(new Event(OPEN_OWNER_UPGRADE_EVENT));
    document
      .getElementById("owner-paid-upgrade")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function startCheckout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/me/billing/payment-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          successUrl: `${window.location.origin}/billing?pm=attached`,
          cancelUrl: `${window.location.origin}/billing`,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        checkoutUrl?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || "Could not start Stripe Checkout");
      }
      const checkoutUrl = stripeCheckoutRedirectUrl(body.checkoutUrl ?? "");
      if (!checkoutUrl) {
        throw new Error("Checkout URL missing or invalid");
      }
      window.location.assign(checkoutUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const useUpgradeCta = upgradeFirst && !hasPaymentMethod;

  let buttonLabel = "Add payment method";
  if (useUpgradeCta) {
    buttonLabel = "Upgrade to Paid";
  } else if (busy) {
    buttonLabel = "Opening Stripe…";
  } else if (hasPaymentMethod) {
    buttonLabel = "Update payment method";
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          if (useUpgradeCta) {
            openUpgrade();
            return;
          }
          void startCheckout();
        }}
      >
        {buttonLabel}
      </button>
      {error ? (
        <p className="max-w-xs text-right text-xs text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
