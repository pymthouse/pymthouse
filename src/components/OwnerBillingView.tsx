import Link from "next/link";

import AllowanceProgressBar from "@/components/AllowanceProgressBar";
import AllowanceStrip from "@/components/AllowanceStrip";
import DashboardLayout from "@/components/DashboardLayout";
import { formatBillingPeriod } from "@/lib/billing-format";
import { formatUsdMicrosDisplay, formatUsdMicrosString } from "@/lib/format-usd-micros";
import type { CreditAllowanceSummary } from "@/lib/openmeter/credit-allowance-summary";
import type { OwnerBillingPayload } from "@/lib/owner-billing-data";

function hasDisplayablePrepaidCredit(
  allowance: CreditAllowanceSummary | null | undefined,
): boolean {
  if (!allowance) return false;
  try {
    const remaining = BigInt(allowance.balanceUsdMicros || "0");
    const granted = BigInt(allowance.lifetimeGrantedUsdMicros || "0");
    return remaining > 0n || granted > 0n;
  } catch {
    return false;
  }
}

function SubscriptionCard({
  row,
}: Readonly<{
  row: OwnerBillingPayload["subscriptions"][number];
}>) {
  const hasAllowance =
    row.discountUsdMicros != null && BigInt(row.discountUsdMicros) > 0n;
  const overage = BigInt(row.overageUsdMicros || "0");
  const usedLabel = formatUsdMicrosString(row.usedUsdMicros, 4) ?? "$0";

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-zinc-100">{row.planName}</h3>
            <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-emerald-400">
              {row.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {row.appName
              ? `${row.appName} · per-app billing wallet`
              : "Shared owner wallet (all apps you own)"}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-sm tabular-nums text-zinc-100">{usedLabel}</p>
          <p className="text-[11px] text-zinc-600">
            {row.requestCount.toLocaleString()} requests this cycle
          </p>
        </div>
      </div>

      {hasAllowance ? (
        <AllowanceProgressBar
          usedUsdMicros={row.usedUsdMicros}
          allowanceUsdMicros={row.discountUsdMicros!}
        />
      ) : (
        <p className="mt-3 text-xs text-zinc-600">
          No included usage allowance on this plan — cycle usage settles against prepaid
          credits.
        </p>
      )}

      {hasAllowance && overage > 0n ? (
        <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Allowance exhausted ·{" "}
          <span className="font-mono tabular-nums">
            {formatUsdMicrosDisplay(overage.toString())}
          </span>{" "}
          overage burns prepaid credits
        </p>
      ) : null}

      {hasAllowance && overage === 0n && BigInt(row.usedUsdMicros) > 0n ? (
        <p className="mt-3 text-xs text-zinc-600">
          Usage is covered by the plan allowance; prepaid credits are not charged yet.
        </p>
      ) : null}
    </div>
  );
}

export default function OwnerBillingView({
  data,
}: Readonly<{
  data: OwnerBillingPayload;
}>) {
  return (
    <DashboardLayout>
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">Billing</h1>
        <p className="mt-1 text-xs sm:text-sm text-zinc-500">
          Prepaid credits and active subscriptions for your account. Plan allowances are
          tracked per billing cycle; prepaid credits burn only after the allowance is
          exhausted.
        </p>
        {data.openMeterConfigured ? (
          <p className="mt-2 text-xs text-zinc-600">
            Cycle: {formatBillingPeriod(data.cycle.start)} —{" "}
            {formatBillingPeriod(data.cycle.end)}
            <span className="mx-2 text-zinc-700">·</span>
            <Link
              href="/usage"
              className="text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              View usage →
            </Link>
          </p>
        ) : (
          <p className="mt-2 text-sm text-amber-400/90">
            OpenMeter is not configured — billing balances are unavailable.
          </p>
        )}
      </div>

      {!data.openMeterConfigured ? null : (
        <>
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold text-zinc-200">Prepaid credits</h2>
            <p className="mb-3 text-xs text-zinc-600">
              Lifetime wallet shared across apps you own. Separate from per-cycle plan
              allowances below.
            </p>
            {hasDisplayablePrepaidCredit(data.creditAllowance) && data.creditAllowance ? (
              <AllowanceStrip
                balanceUsdMicros={data.creditAllowance.balanceUsdMicros}
                lifetimeGrantedUsdMicros={data.creditAllowance.lifetimeGrantedUsdMicros}
                consumedUsdMicros={data.creditAllowance.consumedUsdMicros}
                requestCount={data.subscriptions.reduce(
                  (sum, row) => sum + row.requestCount,
                  0,
                )}
                scopeHint="Prepaid credits for your account (shared across apps you own)."
              />
            ) : (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-5 text-sm text-zinc-500">
                No prepaid credit balance. Starter included usage comes from your plan
                allowance; credits appear here after a payment is received.
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-zinc-200">Active subscriptions</h2>
            <p className="mb-4 text-xs text-zinc-600">
              Usage toward each plan&apos;s included allowance for the current cycle. Overage
              after the allowance burns prepaid credits.
            </p>
            {data.subscriptions.length === 0 ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-center">
                <p className="font-medium text-zinc-300">No active subscriptions</p>
                <p className="mt-1 text-sm text-zinc-500">
                  Create an app or subscribe an end user to a plan to see allowance progress
                  here.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {data.subscriptions.map((row) => (
                  <SubscriptionCard key={row.subscriptionId} row={row} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </DashboardLayout>
  );
}
