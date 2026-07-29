"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { OwnerPaymentMethodSummary } from "@/lib/openmeter/owner-payment-method";

function formatCardBrand(brand: string | null): string {
  if (!brand?.trim()) return "Card";
  const trimmed = brand.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function formatCardExpiry(
  expMonth: number | null,
  expYear: number | null,
): string | null {
  if (expMonth == null || expYear == null) return null;
  const month = String(expMonth).padStart(2, "0");
  const year = String(expYear).slice(-2);
  return `${month}/${year}`;
}

export default function OwnerPaymentMethodCard({
  paymentMethod,
}: Readonly<{
  paymentMethod: OwnerPaymentMethodSummary;
}>) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const brand = formatCardBrand(paymentMethod.brand);
  const last4 = paymentMethod.last4?.trim();
  const title = last4 ? `${brand} ···· ${last4}` : brand;
  const expiry = formatCardExpiry(paymentMethod.expMonth, paymentMethod.expYear);

  async function unlink() {
    if (
      !window.confirm(
        "Unlink this payment method? Platform overage invoices will not charge automatically until you add another card.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/me/billing/payment-method", {
        method: "DELETE",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || "Could not unlink payment method");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-zinc-100">{title}</p>
          <p className="mt-1 text-xs text-zinc-500">
            Default payment method for platform overage invoices
            {expiry ? (
              <>
                <span className="mx-1.5 text-zinc-700">·</span>
                Expires {expiry}
              </>
            ) : null}
          </p>
          {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
            Linked
          </span>
          <button
            type="button"
            className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
            disabled={busy}
            onClick={() => void unlink()}
          >
            {busy ? "Unlinking…" : "Unlink"}
          </button>
        </div>
      </div>
    </div>
  );
}
