"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatUsdMicrosDisplay } from "@/lib/format-usd-micros";

type CreditPayload = {
  creditAllowance: {
    balanceUsdMicros: string;
    lifetimeGrantedUsdMicros: string;
    consumedUsdMicros: string;
    hasAccess: boolean;
  } | null;
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
 */
export default function SidebarCreditPreview() {
  const [balanceLabel, setBalanceLabel] = useState<string | null>(null);

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
        if (cancelled || !hasDisplayableCredit(body.creditAllowance)) return;
        setBalanceLabel(
          formatUsdMicrosDisplay(body.creditAllowance!.balanceUsdMicros),
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
