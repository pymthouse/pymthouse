"use client";

import { useState } from "react";

/**
 * Owner billing: start OpenMeter Stripe Checkout (setup) to attach a card for
 * platform overage invoices.
 */
export default function OwnerPaymentMethodButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/me/billing/payment-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await res.json().catch(() => ({}))) as {
        checkoutUrl?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || "Could not start Stripe Checkout");
      }
      if (!body.checkoutUrl) {
        throw new Error("Checkout URL missing");
      }
      window.location.assign(body.checkoutUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        disabled={busy}
        onClick={() => void startCheckout()}
      >
        {busy ? "Opening Stripe…" : "Add payment method"}
      </button>
      {error ? (
        <p className="max-w-xs text-right text-xs text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
