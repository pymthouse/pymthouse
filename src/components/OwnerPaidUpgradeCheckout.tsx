"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import DashboardLayout from "@/components/DashboardLayout";
import { formatUsdMicrosSummary } from "@/lib/format-usd-micros";
import { stripeCheckoutRedirectUrl } from "@/lib/openmeter/stripe-checkout-session";

type OwnerTier = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyFeeUsd: string;
  includedUsdMicros: string;
};

export type UpgradePaymentMethodSummary = {
  brand: string | null;
  last4: string | null;
  type: string;
};

function paymentMethodLabel(pm: UpgradePaymentMethodSummary): string {
  const brand = pm.brand?.trim() || pm.type.replaceAll("_", " ");
  if (pm.last4) return `${brand} ···· ${pm.last4}`;
  return brand;
}

function confirmLabel(busy: boolean, selected: OwnerTier | null): string {
  if (busy) return "Upgrading…";
  if (selected) return `Confirm — charge $${selected.monthlyFeeUsd} today`;
  return "Confirm Upgrade";
}

/**
 * Full-page Owner Paid Upgrade checkout.
 * Stripe payment-method setup returns here with ?plan=&pm=attached so the
 * selected plan survives the redirect.
 */
export default function OwnerPaidUpgradeCheckout({
  hasPaymentMethod,
  paymentMethod,
  initialPlanKey,
  pmAttached,
}: Readonly<{
  hasPaymentMethod: boolean;
  paymentMethod: UpgradePaymentMethodSummary | null;
  initialPlanKey: string | null;
  pmAttached: boolean;
}>) {
  const router = useRouter();
  const [tiers, setTiers] = useState<OwnerTier[]>([]);
  const [selectedKey, setSelectedKey] = useState(initialPlanKey ?? "");
  const [loadingTiers, setLoadingTiers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pmBusy, setPmBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    pmAttached ? "Payment method saved. Confirm your plan to finish Upgrade." : null,
  );

  const loadTiers = useCallback(async () => {
    setLoadingTiers(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/me/billing/owner-tiers");
      const body = (await res.json().catch(() => ({}))) as {
        tiers?: OwnerTier[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || "Could not load plans");
      }
      const list = body.tiers ?? [];
      setTiers(list);
      setSelectedKey((prev) => {
        if (prev && list.some((t) => t.key === prev)) return prev;
        return list[0]?.key || "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTiers(false);
    }
  }, []);

  useEffect(() => {
    void loadTiers();
  }, [loadTiers]);

  useEffect(() => {
    if (!pmAttached) return;
    // Drop one-shot pm flag so refresh doesn't re-show the notice; keep plan.
    const plan = selectedKey || initialPlanKey;
    const next = plan
      ? `/billing/upgrade?plan=${encodeURIComponent(plan)}`
      : "/billing/upgrade";
    router.replace(next);
    // Only on return from Stripe — not when the user changes plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot
  }, [pmAttached, router]);

  const selected = tiers.find((t) => t.key === selectedKey) ?? null;

  function upgradeUrlWithPlan(extra: Record<string, string> = {}): string {
    const url = new URL("/billing/upgrade", window.location.origin);
    if (selectedKey) url.searchParams.set("plan", selectedKey);
    for (const [k, v] of Object.entries(extra)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  async function startPaymentMethodCheckout() {
    setPmBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/v1/me/billing/payment-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          successUrl: upgradeUrlWithPlan({ pm: "attached" }),
          cancelUrl: upgradeUrlWithPlan(),
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
      // stripeCheckoutRedirectUrl rebuilds from allowlisted Stripe hosts; the
      // regex below is the Snyk-visible guard before navigation (CWE-601).
      if (
        !checkoutUrl ||
        !/^https:\/\/([a-z0-9-]+\.)?checkout\.stripe\.com\//i.test(checkoutUrl)
      ) {
        throw new Error("Checkout URL missing or invalid");
      }
      window.location.assign(checkoutUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPmBusy(false);
    }
  }

  async function confirmUpgrade() {
    if (!selected || !hasPaymentMethod) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/me/billing/upgrade-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKey: selected.key, confirm: true }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || "Upgrade failed");
      }
      router.push("/billing");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <DashboardLayout>
      <div className="mb-6">
        <Link
          href="/billing"
          className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
        >
          ← Back to Billing
        </Link>
        <h1 className="mt-3 text-xl font-bold text-zinc-100 sm:text-2xl">
          Upgrade
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Pick a monthly plan, link a payment method, then confirm. Attaching a
          card does not subscribe you until you confirm.
        </p>
      </div>

      {notice ? (
        <p className="mb-4 text-sm text-emerald-400/90">{notice}</p>
      ) : null}
      {error ? (
        <p className="mb-4 text-sm text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      <section className="mb-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold text-zinc-200">1. Choose a plan</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Confirming charges the monthly fee today and starts a new billing
          cycle.
        </p>
        {loadingTiers ? (
          <p className="mt-4 text-sm text-zinc-400">Loading plans…</p>
        ) : tiers.length === 0 ? (
          <p className="mt-4 text-sm text-amber-300">
            No paid plans are available yet. Ask a platform admin to configure
            Owner Paid tiers.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {tiers.map((tier) => {
              const selectedTier = tier.key === selectedKey;
              const tierClass = selectedTier
                ? "border-emerald-500/50 bg-emerald-500/10"
                : "border-white/10 bg-black/20 hover:border-white/20";
              return (
                <li key={tier.id}>
                  <button
                    type="button"
                    className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${tierClass}`}
                    onClick={() => {
                      setSelectedKey(tier.key);
                      router.replace(
                        `/billing/upgrade?plan=${encodeURIComponent(tier.key)}`,
                      );
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-zinc-100">
                        {tier.name}
                      </span>
                      <span className="text-sm text-emerald-300">
                        ${tier.monthlyFeeUsd}/mo
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">
                      {formatUsdMicrosSummary(tier.includedUsdMicros)} included
                      usage each cycle
                      {tier.description ? ` · ${tier.description}` : ""}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
        <h2 className="text-sm font-semibold text-zinc-200">
          2. Payment method
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Required for the monthly fee and overage invoices after included
          usage.
        </p>
        {hasPaymentMethod && paymentMethod ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zinc-200">
              On file:{" "}
              <span className="font-medium">
                {paymentMethodLabel(paymentMethod)}
              </span>
            </p>
            <button
              type="button"
              className="rounded-md border border-white/10 px-3 py-2 text-sm text-zinc-300 disabled:opacity-50"
              disabled={pmBusy}
              onClick={() => void startPaymentMethodCheckout()}
            >
              {pmBusy ? "Opening Stripe…" : "Update payment method"}
            </button>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-amber-200/90">
              No payment method linked yet.
            </p>
            <button
              type="button"
              className="rounded-md bg-emerald-500/20 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
              disabled={pmBusy}
              onClick={() => void startPaymentMethodCheckout()}
            >
              {pmBusy ? "Opening Stripe…" : "Link payment method"}
            </button>
          </div>
        )}
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        <Link
          href="/billing"
          className="rounded-md border border-white/10 px-3 py-2 text-sm text-zinc-300"
        >
          Cancel
        </Link>
        <button
          type="button"
          className="rounded-md bg-emerald-500/20 px-3 py-2 text-sm text-emerald-200 disabled:opacity-50"
          disabled={busy || !selected || !hasPaymentMethod}
          onClick={() => void confirmUpgrade()}
          title={
            !hasPaymentMethod
              ? "Link a payment method before confirming"
              : undefined
          }
        >
          {confirmLabel(busy, selected)}
        </button>
      </div>
    </DashboardLayout>
  );
}
