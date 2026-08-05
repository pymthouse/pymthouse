"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { formatUsdMicrosSummary } from "@/lib/format-usd-micros";
import { stripeCheckoutRedirectUrl } from "@/lib/openmeter/stripe-checkout-session";

/** Dispatched by header/banner CTAs to open this panel’s chooser. */
export const OPEN_OWNER_UPGRADE_EVENT = "pymthouse:open-owner-upgrade";

type OwnerTier = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyFeeUsd: string;
  includedUsdMicros: string;
};

/**
 * Consentful Upgrade: pick an Owner Paid tier and confirm the monthly charge.
 * Does not auto-upgrade after payment-method attach.
 * Payment-method attach is a step inside Upgrade when no card is on file.
 */
export default function OwnerPaidUpgradePanel({
  hasPaymentMethod,
  onSandboxStarter,
}: Readonly<{
  hasPaymentMethod: boolean;
  onSandboxStarter: boolean;
}>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pmAttached = searchParams.get("pm") === "attached";
  const openUpgrade = searchParams.get("upgrade") === "1";

  const [open, setOpen] = useState(false);
  const [tiers, setTiers] = useState<OwnerTier[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [loadingTiers, setLoadingTiers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pmBusy, setPmBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardSavedNotice, setCardSavedNotice] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const upgradeButtonRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLDivElement | null>(null);

  const openChooser = useCallback(() => {
    setOpen(true);
    setError(null);
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    if (!pmAttached) return;
    setCardSavedNotice(true);
    if (openUpgrade || onSandboxStarter) {
      setOpen(true);
    }
    router.replace("/billing");
  }, [pmAttached, openUpgrade, onSandboxStarter, router]);

  useEffect(() => {
    if (!openUpgrade || pmAttached) return;
    openChooser();
    router.replace("/billing");
  }, [openUpgrade, pmAttached, openChooser, router]);

  useEffect(() => {
    function onOpenEvent() {
      openChooser();
    }
    window.addEventListener(OPEN_OWNER_UPGRADE_EVENT, onOpenEvent);
    return () => window.removeEventListener(OPEN_OWNER_UPGRADE_EVENT, onOpenEvent);
  }, [openChooser]);

  const closeDialog = useCallback(() => {
    setOpen(false);
    setError(null);
    queueMicrotask(() => upgradeButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeDialog]);

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
      setSelectedKey((prev) => prev || list[0]?.key || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTiers(false);
    }
  }, []);

  useEffect(() => {
    if (open && hasPaymentMethod) {
      void loadTiers();
    }
  }, [open, hasPaymentMethod, loadTiers]);

  if (!onSandboxStarter) {
    return cardSavedNotice ? (
      <p className="mb-4 text-sm text-emerald-400/90">
        Payment method saved.
      </p>
    ) : null;
  }

  const selected = tiers.find((t) => t.key === selectedKey) ?? null;

  async function startPaymentMethodCheckout() {
    setPmBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/me/billing/payment-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          successUrl: `${window.location.origin}/billing?pm=attached&upgrade=1`,
          cancelUrl: `${window.location.origin}/billing?upgrade=1`,
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
      setPmBusy(false);
    }
  }

  async function confirmUpgrade() {
    if (!selected) return;
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
        code?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || "Upgrade failed");
      }
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={sectionRef}
      id="owner-paid-upgrade"
      className="mb-6 space-y-3 scroll-mt-6"
    >
      {cardSavedNotice ? (
        <p className="text-sm text-emerald-400/90">
          Payment method saved. Choose a plan below to Upgrade — attaching a card
          does not subscribe you automatically.
        </p>
      ) : null}

      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-emerald-100">
              Upgrade from Sandbox Starter
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              Pick a monthly plan with included usage. Overage still invoices to
              your card after the allowance.
              {!hasPaymentMethod
                ? " You’ll add a payment method as part of Upgrade."
                : null}
            </p>
          </div>
          <button
            ref={upgradeButtonRef}
            type="button"
            className="shrink-0 rounded-md bg-emerald-500/20 px-4 py-2 text-sm text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
            onClick={openChooser}
          >
            Upgrade to Paid
          </button>
        </div>
      </div>

      {open ? (
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 outline-none"
          role="dialog"
          aria-modal="true"
          aria-labelledby="owner-upgrade-title"
        >
          <div className="w-full max-w-lg rounded-xl border border-white/10 bg-zinc-950 p-5 shadow-xl">
            {!hasPaymentMethod ? (
              <>
                <h3
                  id="owner-upgrade-title"
                  className="text-lg font-semibold text-zinc-100"
                >
                  Upgrade to Paid
                </h3>
                <p className="mt-1 text-sm text-zinc-500">
                  Add a payment method, then you’ll pick a monthly plan. Attaching
                  a card does not subscribe you automatically.
                </p>
                {error ? (
                  <p className="mt-3 text-sm text-red-400" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-white/10 px-3 py-2 text-sm text-zinc-300"
                    disabled={pmBusy}
                    onClick={closeDialog}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-emerald-500/20 px-3 py-2 text-sm text-emerald-200 disabled:opacity-50"
                    disabled={pmBusy}
                    onClick={() => void startPaymentMethodCheckout()}
                  >
                    {pmBusy ? "Opening Stripe…" : "Continue — add payment method"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3
                  id="owner-upgrade-title"
                  className="text-lg font-semibold text-zinc-100"
                >
                  Choose a plan
                </h3>
                <p className="mt-1 text-sm text-zinc-500">
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
                      return (
                        <li key={tier.id}>
                          <button
                            type="button"
                            className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                              selectedTier
                                ? "border-emerald-500/50 bg-emerald-500/10"
                                : "border-white/10 bg-black/20 hover:border-white/20"
                            }`}
                            onClick={() => setSelectedKey(tier.key)}
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

                {error ? (
                  <p className="mt-3 text-sm text-red-400" role="alert">
                    {error}
                  </p>
                ) : null}

                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-white/10 px-3 py-2 text-sm text-zinc-300"
                    disabled={busy}
                    onClick={closeDialog}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-emerald-500/20 px-3 py-2 text-sm text-emerald-200 disabled:opacity-50"
                    disabled={busy || !selected}
                    onClick={() => void confirmUpgrade()}
                  >
                    {busy
                      ? "Upgrading…"
                      : selected
                        ? `Confirm — charge $${selected.monthlyFeeUsd} today`
                        : "Confirm Upgrade"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
