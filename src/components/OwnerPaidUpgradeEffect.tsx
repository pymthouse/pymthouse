"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const PAYMENT_METHOD_SYNC_ATTEMPTS = 5;
const PAYMENT_METHOD_SYNC_BASE_DELAY_MS = 1000;

/**
 * After Stripe Checkout returns (`?pm=attached`), upgrade Sandbox Starter →
 * Owner Paid. Also upgrades when a payment method is already on file but the
 * wallet is still on Sandbox Starter.
 */
export default function OwnerPaidUpgradeEffect({
  hasPaymentMethod,
  onSandboxStarter,
}: Readonly<{
  hasPaymentMethod: boolean;
  onSandboxStarter: boolean;
}>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);

  const pmAttached = searchParams.get("pm") === "attached";
  const shouldUpgrade =
    hasPaymentMethod && (onSandboxStarter || pmAttached);

  useEffect(() => {
    if (!shouldUpgrade || attempted.current) {
      return;
    }
    attempted.current = true;
    let cancelled = false;

    async function upgrade() {
      setBusy(true);
      setError(null);
      try {
        for (let attempt = 0; attempt < PAYMENT_METHOD_SYNC_ATTEMPTS; attempt += 1) {
          if (cancelled) {
            return;
          }
          const res = await fetch("/api/v1/me/billing/upgrade-paid", {
            method: "POST",
          });
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            code?: string;
          };
          if (res.ok) {
            if (!cancelled) {
              router.replace("/billing");
              router.refresh();
            }
            return;
          }
          if (body.code === "payment_method_required") {
            // Stripe/Konnect may still be syncing the new card after checkout.
            if (attempt + 1 < PAYMENT_METHOD_SYNC_ATTEMPTS) {
              const delayMs =
                PAYMENT_METHOD_SYNC_BASE_DELAY_MS * (attempt + 1);
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              continue;
            }
            throw new Error(
              "Payment method is not ready yet. Retry in a moment.",
            );
          }
          throw new Error(body.error || "Could not upgrade to Owner Paid");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    }

    void upgrade();
    return () => {
      cancelled = true;
    };
  }, [shouldUpgrade, router]);

  if (!shouldUpgrade && !error) {
    return null;
  }

  if (busy) {
    return (
      <p className="mb-4 text-sm text-zinc-400">
        Upgrading to Owner Paid…
      </p>
    );
  }

  if (error) {
    return (
      <output className="mb-4 block rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        {error}{" "}
        <button
          type="button"
          className="underline"
          onClick={() => {
            attempted.current = false;
            setError(null);
            router.refresh();
          }}
        >
          Retry
        </button>
      </output>
    );
  }

  return null;
}
