"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatUsdMicrosSummary } from "@/lib/format-usd-micros";

type CreditPayload = {
  creditAllowance: {
    balanceUsdMicros: string;
    lifetimeGrantedUsdMicros: string;
    consumedUsdMicros: string;
    hasAccess: boolean;
  } | null;
  /**
   * Owner billing pressure for the sidebar nudge. Omitted on older responses.
   * `blocked` means spendable is zero without a payment method.
   */
  billingPressure?: "solvent" | "blocked" | "chargeable";
};

function hasDisplayableCredit(allowance: CreditPayload["creditAllowance"]): boolean {
  if (!allowance) return false;
  try {
    const remaining = BigInt(allowance.balanceUsdMicros || "0");
    const granted = BigInt(allowance.lifetimeGrantedUsdMicros || "0");
    return remaining > 0n || granted > 0n;
  } catch {
    return false;
  }
}

/**
 * Quiet credit balance line for the dashboard sidebar user panel.
 * Fetches the shared owner wallet via GET /api/v1/me/credits.
 * When Starter spendable is exhausted without a card, surfaces a blocked nudge.
 */
export default function SidebarCreditPreview() {
  const [balanceLabel, setBalanceLabel] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      try {
        const res = await fetch("/api/v1/me/credits", {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const body = (await res.json()) as CreditPayload;
        if (cancelled) return;
        if (body.billingPressure === "blocked") {
          setBlocked(true);
          setBalanceLabel(null);
          return;
        }
        if (!hasDisplayableCredit(body.creditAllowance)) return;
        setBlocked(false);
        setBalanceLabel(
          formatUsdMicrosSummary(body.creditAllowance!.balanceUsdMicros),
        );
      } catch {
        // Non-blocking preview — ignore abort/network/OpenMeter failures.
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  if (blocked) {
    return (
      <Link
        href="/billing"
        className="block text-[11px] text-amber-400/90 hover:text-amber-300 transition-colors"
        title="Attach a payment method to continue usage"
      >
        Payment method required
      </Link>
    );
  }

  if (!balanceLabel) return null;

  return (
    <Link
      href="/billing"
      className="block text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
      title="View billing and prepaid credits"
    >
      Credits{" "}
      <span className="font-mono tabular-nums text-zinc-400">{balanceLabel}</span>
    </Link>
  );
}
