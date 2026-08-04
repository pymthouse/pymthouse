import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import AllowanceProgressBar from "@/components/AllowanceProgressBar";
import AllowanceStrip from "@/components/AllowanceStrip";
import CostWaterfall from "@/components/billing/CostWaterfall";
import PlatformInvoicesTable from "@/components/billing/PlatformInvoicesTable";
import TransactionsLedger from "@/components/billing/TransactionsLedger";
import DashboardLayout from "@/components/DashboardLayout";
import InfoTooltip from "@/components/InfoTooltip";
import OwnerPaidUpgradeEffect from "@/components/OwnerPaidUpgradeEffect";
import OwnerPaymentMethodsCard from "@/components/OwnerPaymentMethodsCard";
import CycleRange from "@/components/billing/CycleRange";
import { allocateCreditBalancesForSubscriptions } from "@/lib/billing/cost-waterfall";
import { resolveOwnerBillingPressure } from "@/lib/billing/owner-billing-pressure";
import { formatUsdMicrosSummary } from "@/lib/format-usd-micros";
import type { CreditAllowanceSummary } from "@/lib/openmeter/credit-allowance-summary";
import { isOwnerStarterPlanKey } from "@/lib/openmeter/owner-starter-key";
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
  creditBalanceUsdMicros,
  defaultPaymentMethod,
  needsPaymentMethod,
}: Readonly<{
  row: OwnerBillingPayload["subscriptions"][number];
  creditBalanceUsdMicros: string | null;
  defaultPaymentMethod: OwnerBillingPayload["paymentMethods"][number] | null;
  needsPaymentMethod: boolean;
}>) {
  const hasAllowance =
    row.discountUsdMicros != null && BigInt(row.discountUsdMicros) > 0n;
  const usedLabel = formatUsdMicrosSummary(row.usedUsdMicros);

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
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
            {row.appName ? (
              <>
                {row.appName}
                <span className="text-zinc-600">·</span>
                <span>App billing</span>
              </>
            ) : (
              <>
                Your account
                <InfoTooltip
                  label="Prepaid credits and plan usage for your account — usable across all apps you own."
                  wide
                />
              </>
            )}
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
      ) : null}

      <CostWaterfall
        className="mt-4"
        usedUsdMicros={row.usedUsdMicros}
        planIncludedUsdMicros={row.discountUsdMicros}
        creditBalanceUsdMicros={creditBalanceUsdMicros}
        paymentMethod={defaultPaymentMethod}
        needsPaymentMethod={needsPaymentMethod}
      />
    </div>
  );
}

function billingIntroCopy(
  pressure: ReturnType<typeof resolveOwnerBillingPressure>,
): string {
  if (pressure === "blocked") {
    return "Sandbox Starter allowance is used up. Usage is paused until you add a payment method and upgrade to Owner Paid.";
  }
  if (pressure === "chargeable") {
    return "Prepaid credits, active subscriptions, and platform invoices for your account. Overage invoices charge your default payment method.";
  }
  return "Prepaid credits, active subscriptions, and platform invoices for your account. On Sandbox Starter, usage stops when included allowance and credits run out — add a payment method to continue on Owner Paid.";
}

function PaymentMethodRequiredBanner({
  paymentMethodPanel,
}: Readonly<{
  paymentMethodPanel?: ReactNode;
}>) {
  return (
    <output className="mb-6 block w-full rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-amber-100">
            Add payment method to continue on Paid
          </h2>
          <p className="mt-1 text-sm text-amber-200/90">
            Sandbox Starter allowance used up. Attach a card to upgrade to Owner
            Paid so overage can invoice on Stripe.
          </p>
        </div>
        {paymentMethodPanel ? (
          <div className="shrink-0">{paymentMethodPanel}</div>
        ) : null}
      </div>
    </output>
  );
}

function OwnerPaymentCreditsSection({
  data,
  needsPaymentMethod,
  paymentMethodPanel,
  adminFundPanel,
}: Readonly<{
  data: OwnerBillingPayload;
  needsPaymentMethod: boolean;
  paymentMethodPanel?: ReactNode;
  adminFundPanel?: ReactNode;
}>) {
  const billingActions =
    paymentMethodPanel || adminFundPanel ? (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {paymentMethodPanel}
        {adminFundPanel}
      </div>
    ) : null;
  const showEmptyHint =
    data.paymentMethods.length === 0 &&
    !hasDisplayablePrepaidCredit(data.creditAllowance) &&
    !needsPaymentMethod;

  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-200">Payment &amp; credits</h2>
          <InfoTooltip
            label="Add a Stripe card for automatic overage invoices. Prepaid credits (when present) burn first under credit_then_invoice settlement."
            wide
          />
        </div>
        {needsPaymentMethod ? adminFundPanel : billingActions}
      </div>
      <div className="space-y-3">
        {data.paymentMethods.length > 0 ? (
          <OwnerPaymentMethodsCard paymentMethods={data.paymentMethods} />
        ) : null}
        {hasDisplayablePrepaidCredit(data.creditAllowance) && data.creditAllowance ? (
          <AllowanceStrip
            balanceUsdMicros={data.creditAllowance.balanceUsdMicros}
            lifetimeGrantedUsdMicros={data.creditAllowance.lifetimeGrantedUsdMicros}
            consumedUsdMicros={data.creditAllowance.consumedUsdMicros}
            requestCount={data.subscriptions.reduce(
              (sum, row) => sum + row.requestCount,
              0,
            )}
          />
        ) : null}
        {showEmptyHint ? (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-5 text-sm text-zinc-500">
            <p>
              No prepaid credit balance yet. Starter included usage comes from your plan
              allowance. Attach a payment method so usage beyond the allowance can be
              invoiced on Stripe.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * What the platform plan covers.
 *
 * Both modes cost the owner: `merchant` only changes whether the Builder also
 * bills their own end users on top. Stating that here answers "where does my
 * usage go?" without opening each app. See docs/adr-owner-vs-app-billing.md.
 */
function PlanCoverage({
  ownedApps,
}: Readonly<{ ownedApps: OwnerBillingPayload["ownedApps"] }>) {
  if (ownedApps.length === 0) {
    return null;
  }
  const merchant = ownedApps.filter((app) => app.billingMode === "merchant");
  const rollup = ownedApps.filter((app) => app.billingMode !== "merchant");

  const summary =
    merchant.length > 0
      ? `${rollup.length} roll up · ${merchant.length} also bill their own users`
      : "all usage rolls up here";

  // Native <details> so the list collapses without making this server-rendered
  // page a client component.
  return (
    <details className="group mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
        <svg
          className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
        <span className="font-medium text-zinc-300">
          Covers {ownedApps.length} app{ownedApps.length === 1 ? "" : "s"}
        </span>
        <span className="text-zinc-600">{summary}</span>
      </summary>

      <div className="border-t border-white/[0.06] px-4 py-3">
        <ul className="space-y-1.5">
          {ownedApps.map((app) => (
            <li
              key={app.id}
              className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
            >
              <Link
                href={`/apps/${app.id}/usage`}
                className="text-zinc-300 transition-colors hover:text-emerald-400"
              >
                {app.name}
              </Link>
              <span className="text-zinc-600">
                {app.billingMode === "merchant"
                  ? "bills its own end users · network cost rolls up here"
                  : "usage rolls up here"}
              </span>
            </li>
          ))}
        </ul>
        {merchant.length > 0 ? (
          <p className="mt-2 text-[11px] text-zinc-600">
            {merchant.length} app{merchant.length === 1 ? "" : "s"} charge their end
            users directly; you still pay PymtHouse for the network usage
            {rollup.length > 0
              ? `, as you do for the other ${rollup.length}.`
              : "."}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function OwnerSubscriptionsSection({
  data,
  defaultPaymentMethod,
  needsPaymentMethod,
}: Readonly<{
  data: OwnerBillingPayload;
  defaultPaymentMethod: OwnerBillingPayload["paymentMethods"][number] | null;
  needsPaymentMethod: boolean;
}>) {
  const creditBySubscription = allocateCreditBalancesForSubscriptions(
    data.subscriptions,
    data.creditAllowance?.balanceUsdMicros ?? null,
  );

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-zinc-200">
        Your PymtHouse plan
      </h2>
      <p className="mb-4 text-xs text-zinc-600">
        One plan for your whole account. Every app you own bills its network usage
        here — each card shows where this cycle&apos;s usage settled.
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
            <SubscriptionCard
              key={row.subscriptionId}
              row={row}
              creditBalanceUsdMicros={
                creditBySubscription.get(row.subscriptionId) ?? "0"
              }
              defaultPaymentMethod={defaultPaymentMethod}
              needsPaymentMethod={needsPaymentMethod}
            />
          ))}
        </div>
      )}
      <PlanCoverage ownedApps={data.ownedApps} />
    </section>
  );
}

export default function OwnerBillingView({
  data,
  paymentMethodPanel,
  adminFundPanel,
}: Readonly<{
  data: OwnerBillingPayload;
  /** Stripe Checkout (setup) to attach a card for platform overage invoices. */
  paymentMethodPanel?: ReactNode;
  /** Admin-only MoonPay signer refill tooling (hidden from normal owners). */
  adminFundPanel?: ReactNode;
}>) {
  const pressure = resolveOwnerBillingPressure({
    hasPaymentMethod: data.paymentMethods.length > 0,
    creditBalanceUsdMicros: data.creditAllowance?.balanceUsdMicros ?? null,
    subscriptions: data.subscriptions,
  });
  const needsPaymentMethod = pressure === "blocked";
  const defaultPaymentMethod =
    data.paymentMethods.find((m) => m.isDefault) ??
    data.paymentMethods[0] ??
    null;
  const onSandboxStarter = data.subscriptions.some((row) =>
    isOwnerStarterPlanKey(row.openMeterPlanKey),
  );

  return (
    <DashboardLayout>
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold text-zinc-100">Billing</h1>
        <p className="mt-1 text-xs sm:text-sm text-zinc-500">
          {billingIntroCopy(pressure)}
        </p>
        {data.openMeterConfigured ? (
          <p className="mt-2 text-xs text-zinc-600">
            Cycle: <CycleRange start={data.cycle.start} end={data.cycle.end} />
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
            Usage metering is not configured — billing balances are unavailable.
          </p>
        )}
      </div>

      {data.openMeterConfigured ? (
        <>
          <Suspense fallback={null}>
            <OwnerPaidUpgradeEffect
              hasPaymentMethod={data.paymentMethods.length > 0}
              onSandboxStarter={onSandboxStarter}
            />
          </Suspense>

          {needsPaymentMethod ? (
            <PaymentMethodRequiredBanner paymentMethodPanel={paymentMethodPanel} />
          ) : null}

          <OwnerPaymentCreditsSection
            data={data}
            needsPaymentMethod={needsPaymentMethod}
            paymentMethodPanel={paymentMethodPanel}
            adminFundPanel={adminFundPanel}
          />

          <OwnerSubscriptionsSection
            data={data}
            defaultPaymentMethod={defaultPaymentMethod}
            needsPaymentMethod={needsPaymentMethod}
          />

          <section className="mt-8">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-200">Platform invoices</h2>
              <InfoTooltip
                label="Invoices from PymtHouse to your developer account (overage and top-ups). End-user invoices billed through your Merchant Stripe Connect account appear on each app’s Payments tab."
                wide
              />
            </div>
            <PlatformInvoicesTable invoices={data.invoices} />
          </section>

          <section className="mt-8">
            <TransactionsLedger entries={data.ledger} />
          </section>
        </>
      ) : null}
    </DashboardLayout>
  );
}
