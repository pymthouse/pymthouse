"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const PAYMENT_METHOD_SYNC_ATTEMPTS = 5;
const PAYMENT_METHOD_SYNC_BASE_DELAY_MS = 1000;

type UpgradeAttemptResult =
  | { kind: "ok" }
  | { kind: "retry"; delayMs: number }
  | { kind: "fail"; message: string };

async function attemptOwnerPaidUpgrade(
  attempt: number,
): Promise<UpgradeAttemptResult> {
  const res = await fetch("/api/v1/me/billing/upgrade-paid", {
    method: "POST",
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (res.ok) {
    return { kind: "ok" };
  }
  if (body.code !== "payment_method_required") {
    return {
      kind: "fail",
      message: body.error || "Could not upgrade to Owner Paid",
    };
  }
  if (attempt + 1 >= PAYMENT_METHOD_SYNC_ATTEMPTS) {
    return {
      kind: "fail",
      message: "Payment method is not ready yet. Retry in a moment.",
    };
  }
  return {
    kind: "retry",
    delayMs: PAYMENT_METHOD_SYNC_BASE_DELAY_MS * (attempt + 1),
  };
}

async function runOwnerPaidUpgradeAttempts(
  isCancelled: () => boolean,
): Promise<"ok" | "cancelled"> {
  for (let attempt = 0; attempt < PAYMENT_METHOD_SYNC_ATTEMPTS; attempt += 1) {
    if (isCancelled()) {
      return "cancelled";
    }
    const result = await attemptOwnerPaidUpgrade(attempt);
    if (result.kind === "retry") {
      await new Promise((resolve) => setTimeout(resolve, result.delayMs));
      continue;
    }
    if (result.kind === "fail") {
      throw new Error(result.message);
    }
    return "ok";
  }
  throw new Error("Could not upgrade to Owner Paid");
}

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
        const outcome = await runOwnerPaidUpgradeAttempts(() => cancelled);
        if (outcome === "ok" && !cancelled) {
          router.replace("/billing");
          router.refresh();
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
