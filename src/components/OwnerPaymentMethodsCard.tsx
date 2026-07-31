"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { OwnerPaymentMethodListItem } from "@/lib/openmeter/owner-payment-method";

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function isLinkPaymentMethod(pm: OwnerPaymentMethodListItem): boolean {
  return pm.type === "link" || pm.brand?.toLowerCase() === "link";
}

/** "Visa ···· 4242", "Chase ···· 6789", or a humanized type (Link uses its mark). */
function paymentMethodTitle(pm: OwnerPaymentMethodListItem): string {
  if (isLinkPaymentMethod(pm)) {
    return "Link";
  }
  const brand = pm.brand?.trim()
    ? titleCase(pm.brand)
    : titleCase(pm.type.replaceAll("_", " "));
  return pm.last4 ? `${brand} ···· ${pm.last4}` : brand;
}

function paymentMethodDetail(pm: OwnerPaymentMethodListItem): string | null {
  if (pm.expMonth == null || pm.expYear == null) {
    return null;
  }
  const month = String(pm.expMonth).padStart(2, "0");
  return `Expires ${month}/${String(pm.expYear).slice(-2)}`;
}

/** Stripe Link–inspired mark: green pill + chain icon + wordmark. */
function StripeLinkMark() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-[#00D66F]/15 px-2.5 py-1 text-[#00D66F] ring-1 ring-inset ring-[#00D66F]/30"
      aria-label="Stripe Link"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <path
          d="M6.2 9.8a3.2 3.2 0 0 1 0-4.5l1.4-1.4a3.2 3.2 0 0 1 4.5 4.5L11 9.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M9.8 6.2a3.2 3.2 0 0 1 0 4.5L8.4 12.1a3.2 3.2 0 1 1-4.5-4.5L5 6.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-sm font-semibold tracking-tight">Link</span>
    </span>
  );
}

function RemovePaymentMethodDialog({
  paymentMethod,
  busy,
  error,
  onCancel,
  onConfirm,
}: Readonly<{
  paymentMethod: OwnerPaymentMethodListItem;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const label = paymentMethodTitle(paymentMethod);
  const detail = paymentMethodDetail(paymentMethod);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onCancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Dismiss"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        disabled={busy}
        onClick={onCancel}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-10 w-full max-w-md rounded-t-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl sm:mx-4 sm:rounded-2xl"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-zinc-700 sm:hidden" />
        <h3 id={titleId} className="text-base font-semibold text-zinc-100">
          Remove {label}?
        </h3>
        <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-zinc-400">
          {paymentMethod.isDefault
            ? "This is your default payment method. Platform overage invoices will not charge automatically until you pick another."
            : "This payment method will be detached from your account. You can add it again later."}
          {detail ? (
            <>
              {" "}
              <span className="text-zinc-500">({detail})</span>
            </>
          ) : null}
        </p>
        {error ? (
          <p className="mt-3 text-sm text-red-400" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            className="min-h-11 rounded-lg border border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-200 hover:bg-white/5 disabled:opacity-50"
            disabled={busy}
            onClick={onCancel}
          >
            Keep it
          </button>
          <button
            type="button"
            className="min-h-11 rounded-lg border border-red-500/30 bg-red-500/15 px-4 py-2.5 text-sm font-medium text-red-300 hover:bg-red-500/25 disabled:opacity-50"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OwnerPaymentMethodsCard({
  paymentMethods,
}: Readonly<{
  paymentMethods: OwnerPaymentMethodListItem[];
}>) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] =
    useState<OwnerPaymentMethodListItem | null>(null);
  const cancelRemove = useCallback(() => {
    setPendingRemove(null);
  }, []);

  async function callApi(init: RequestInit & { url: string }, id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(init.url, init);
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || "Payment method update failed");
      }
      setPendingRemove(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function makeDefault(pm: OwnerPaymentMethodListItem) {
    void callApi(
      {
        url: "/api/v1/me/billing/payment-method",
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethodId: pm.id }),
      },
      pm.id,
    );
  }

  function confirmRemove() {
    if (!pendingRemove) {
      return;
    }
    void callApi(
      {
        url: `/api/v1/me/billing/payment-method?id=${encodeURIComponent(pendingRemove.id)}`,
        method: "DELETE",
      },
      pendingRemove.id,
    );
  }

  return (
    <div className="rounded-xl border border-white/6 bg-white/2 px-4 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Payment methods
      </p>
      <ul className="mt-3 divide-y divide-white/5">
        {paymentMethods.map((pm) => {
          const busy = busyId === pm.id;
          const detail = paymentMethodDetail(pm);
          return (
            <li
              key={pm.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div>
                {isLinkPaymentMethod(pm) ? (
                  <StripeLinkMark />
                ) : (
                  <p className="text-sm font-medium text-zinc-100">
                    {paymentMethodTitle(pm)}
                  </p>
                )}
                <p className="mt-1 text-xs text-zinc-500">
                  {pm.isDefault
                    ? "Default for platform overage invoices"
                    : isLinkPaymentMethod(pm)
                      ? "Stripe Link wallet"
                      : "On file"}
                  {detail ? (
                    <>
                      <span className="mx-1.5 text-zinc-700">·</span>
                      {detail}
                    </>
                  ) : null}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {pm.isDefault ? (
                  <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
                    Default
                  </span>
                ) : (
                  <button
                    type="button"
                    className="min-h-9 rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-50"
                    disabled={busyId !== null}
                    onClick={() => makeDefault(pm)}
                  >
                    {busy ? "Updating…" : "Make default"}
                  </button>
                )}
                <button
                  type="button"
                  className="min-h-9 rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
                  disabled={busyId !== null}
                  onClick={() => setPendingRemove(pm)}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error && !pendingRemove ? (
        <p className="mt-3 text-xs text-red-400">{error}</p>
      ) : null}
      {pendingRemove ? (
        <RemovePaymentMethodDialog
          paymentMethod={pendingRemove}
          busy={busyId === pendingRemove.id}
          error={error}
          onCancel={cancelRemove}
          onConfirm={confirmRemove}
        />
      ) : null}
    </div>
  );
}
