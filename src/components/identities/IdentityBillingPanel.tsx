"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { formatUsdMicrosSummary } from "@/lib/format-usd-micros";
import { formatBillingUtcDate } from "@/lib/billing-format";
import { invoiceOverlapsCycle } from "@/lib/billing-utils";

type BillingMode = "owner_rollup" | "merchant";

type IncludedUsage = {
  usdMicros: string;
  usd: string;
} | null;

type PlanSurface = {
  id: string | null;
  name: string | null;
  type: string | null;
  includedUsage: IncludedUsage;
  effectiveAt: string | null;
};

type PendingCancel = {
  subscriptionId: string;
  planName: string | null;
  effectiveAt: string | null;
} | null;

type SubscriptionPayload = {
  externalUserId: string;
  subscription: {
    id: string;
    status: string;
    planId: string | null;
    planName: string | null;
    planType: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
  } | null;
  pendingCancel: PendingCancel;
  livePlan: PlanSurface | null;
  pendingPlan: PlanSurface | null;
};

type CatalogPlan = {
  id: string;
  name: string;
  type: string;
  status: string;
  priceAmount: string;
  priceCurrency: string;
  includedUsdMicros: string | null;
  isStarterDefault?: boolean;
};

type InvoiceItem = {
  id: string;
  number?: string;
  status: string;
  currency?: string;
  totalAmount: string;
  issuedAt?: string;
  periodStart?: string;
  periodEnd?: string;
  invoiceType?: string;
};

type AllowancePayload = {
  live?: string;
  settled?: string;
  currency?: string;
};

function includedLabel(included: IncludedUsage | string | null | undefined): string | null {
  if (!included) return null;
  if (typeof included === "string") {
    return formatUsdMicrosSummary(included);
  }
  if (!included.usdMicros) return null;
  return formatUsdMicrosSummary(included.usdMicros);
}

function planPriceLabel(plan: CatalogPlan): string {
  const amount = plan.priceAmount?.trim() || "0";
  const currency = (plan.priceCurrency || "USD").toUpperCase();
  if (plan.type === "free" || plan.isStarterDefault || amount === "0" || amount === "0.00") {
    return "Free";
  }
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

/**
 * Merchant-mode identity billing: current plan, included usage discount,
 * plan change / cancel, prepaid balance, and invoice history.
 */
export default function IdentityBillingPanel({
  appId,
  externalUserId,
  billingMode,
  canManage,
  cycle,
}: Readonly<{
  appId: string;
  externalUserId: string;
  billingMode: BillingMode;
  canManage: boolean;
  cycle: { start: string; end: string };
}>) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionPayload | null>(null);
  const [plans, setPlans] = useState<CatalogPlan[]>([]);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [allowance, setAllowance] = useState<AllowancePayload | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cycleOnly, setCycleOnly] = useState(true);

  const base = `/api/v1/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(externalUserId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [subRes, plansRes, invoicesRes, allowanceRes] = await Promise.all([
        fetch(`${base}/subscription`, { credentials: "same-origin" }),
        fetch(`/api/v1/apps/${encodeURIComponent(appId)}/plans`, {
          credentials: "same-origin",
        }),
        fetch(`${base}/invoices?page=1&pageSize=50`, { credentials: "same-origin" }),
        fetch(`${base}/allowances`, { credentials: "same-origin" }),
      ]);

      const subBody = (await subRes.json().catch(() => null)) as
        | SubscriptionPayload
        | { error?: string }
        | null;
      if (!subRes.ok) {
        throw new Error(
          (subBody && "error" in subBody && subBody.error) ||
            `Subscription lookup failed (${subRes.status})`,
        );
      }
      setSubscription(subBody as SubscriptionPayload);

      const plansBody = (await plansRes.json().catch(() => null)) as {
        plans?: CatalogPlan[];
      } | null;
      const catalog = (plansBody?.plans ?? []).filter(
        (plan) => plan.status === "active" || plan.status === "phase_out",
      );
      setPlans(catalog);

      const invoicesBody = (await invoicesRes.json().catch(() => null)) as {
        items?: InvoiceItem[];
      } | null;
      setInvoices(invoicesBody?.items ?? []);

      if (allowanceRes.ok) {
        setAllowance((await allowanceRes.json()) as AllowancePayload);
      } else {
        setAllowance(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, [appId, base]);

  useEffect(() => {
    if (billingMode === "owner_rollup") {
      setLoading(false);
      return;
    }
    void load();
  }, [billingMode, load]);

  const livePlanId = subscription?.livePlan?.id ?? subscription?.subscription?.planId ?? "";
  useEffect(() => {
    if (!selectedPlanId && livePlanId) {
      setSelectedPlanId(livePlanId);
    }
  }, [livePlanId, selectedPlanId]);

  const selectablePlans = useMemo(
    () => plans.filter((plan) => plan.status === "active"),
    [plans],
  );

  const visibleInvoices = useMemo(
    () =>
      cycleOnly
        ? invoices.filter((invoice) => invoiceOverlapsCycle(invoice, cycle))
        : invoices,
    [invoices, cycle, cycleOnly],
  );

  async function readError(res: Response): Promise<string> {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      detail?: string;
      title?: string;
    } | null;
    return body?.detail || body?.title || body?.error || `HTTP ${res.status}`;
  }

  async function changePlan() {
    if (!selectedPlanId || selectedPlanId === livePlanId) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`${base}/subscription/change`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: selectedPlanId,
          successUrl: globalThis.location.href,
          cancelUrl: globalThis.location.href,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        checkoutUrl?: string;
        subscriptionId?: string;
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      if (body?.checkoutUrl && !body.subscriptionId) {
        globalThis.location.href = body.checkoutUrl;
        return;
      }
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Plan change failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancelSubscription() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`${base}/subscription`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  async function resumeSubscription() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`${base}/subscription/pending-change`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Resume failed");
    } finally {
      setBusy(false);
    }
  }

  async function openInvoice(invoiceId: string) {
    const res = await fetch(`${base}/invoices/${encodeURIComponent(invoiceId)}/hosted-url`, {
      credentials: "same-origin",
    });
    const body = (await res.json().catch(() => null)) as {
      hostedInvoiceUrl?: string | null;
      invoicePdf?: string | null;
      error?: string;
    } | null;
    const url = body?.hostedInvoiceUrl || body?.invoicePdf;
    if (!res.ok || !url) return;
    globalThis.open(url, "_blank", "noopener,noreferrer");
  }

  if (billingMode === "owner_rollup") {
    return (
      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-4 sm:px-5">
        <h2 className="text-sm font-semibold text-zinc-200">Subscription &amp; billing</h2>
        <p className="mt-1 text-xs text-zinc-500">
          This identity rolls up to your platform wallet. Network usage is billed on
          your owner plan, not as a separate M2M customer.
        </p>
        <Link
          href="/billing"
          className="mt-3 inline-block text-sm text-emerald-400 transition-colors hover:text-emerald-300"
        >
          Open Billing →
        </Link>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-4 sm:px-5">
        <h2 className="text-sm font-semibold text-zinc-200">Subscription &amp; billing</h2>
        <div className="mt-3 animate-pulse space-y-2">
          <div className="h-4 w-48 rounded bg-zinc-800" />
          <div className="h-4 w-32 rounded bg-zinc-800" />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-4 sm:px-5">
        <h2 className="text-sm font-semibold text-zinc-200">Subscription &amp; billing</h2>
        <p className="mt-2 text-sm text-red-400">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 text-sm text-emerald-400 hover:text-emerald-300"
        >
          Retry
        </button>
      </section>
    );
  }

  const live = subscription?.livePlan;
  const pending = subscription?.pendingPlan;
  const pendingCancel = subscription?.pendingCancel;
  const discount = includedLabel(live?.includedUsage);
  const prepaid = allowance?.live ?? allowance?.settled ?? null;

  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-4 sm:px-5">
      <h2 className="text-sm font-semibold text-zinc-200">Subscription &amp; billing</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Merchant customer for this M2M identity — plan, included usage discount, and
        payment history.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3">
          <p className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Plan
          </p>
          <p className="mt-1 text-sm text-zinc-100">
            {live?.name || subscription?.subscription?.planName || "None"}
          </p>
          <p className="mt-0.5 text-[11px] uppercase tracking-wider text-zinc-500">
            {subscription?.subscription?.status || "unsubscribed"}
          </p>
        </div>
        <div className="rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3">
          <p className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Included usage
          </p>
          <p className="mt-1 font-mono text-sm tabular-nums text-zinc-100">
            {discount ?? "None"}
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-500">Per billing cycle discount</p>
        </div>
        <div className="rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3">
          <p className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Prepaid credits
          </p>
          <p className="mt-1 font-mono text-sm tabular-nums text-zinc-100">
            {prepaid != null && prepaid !== ""
              ? prepaid.startsWith("$")
                ? prepaid
                : `$${prepaid}`
              : "—"}
          </p>
        </div>
      </div>

      {pending ? (
        <p className="mt-3 text-xs text-amber-200/90">
          Scheduled: {pending.name || "new plan"}
          {pending.effectiveAt
            ? ` on ${formatBillingUtcDate(pending.effectiveAt, { year: "numeric" })}`
            : " at the end of this cycle"}
          {pending.includedUsage
            ? ` · ${includedLabel(pending.includedUsage)} included`
            : ""}
        </p>
      ) : null}

      {pendingCancel ? (
        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-3">
          <p className="text-sm text-amber-100">
            Cancel scheduled
            {pendingCancel.effectiveAt
              ? ` for ${formatBillingUtcDate(pendingCancel.effectiveAt, { year: "numeric" })}`
              : " at period end"}
            {pendingCancel.planName ? ` · ${pendingCancel.planName}` : ""}
          </p>
          {canManage ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void resumeSubscription()}
              className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
            >
              {busy ? "Working…" : "Keep current plan"}
            </button>
          ) : null}
        </div>
      ) : null}

      {canManage && selectablePlans.length > 0 ? (
        <div className="mt-4 rounded-lg border border-white/[0.05] bg-black/10 px-3 py-3">
          <p className="text-xs font-medium text-zinc-300">Change plan</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Switching plans updates this customer&apos;s included usage discount.
            Paid upgrades may send the customer through checkout.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="min-w-[12rem] flex-1 text-xs text-zinc-500">
              Plan
              <select
                value={selectedPlanId}
                onChange={(event) => setSelectedPlanId(event.target.value)}
                className="mt-1 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-zinc-100"
              >
                {selectablePlans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} · {planPriceLabel(plan)}
                    {plan.includedUsdMicros
                      ? ` · ${formatUsdMicrosSummary(plan.includedUsdMicros)} included`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !selectedPlanId || selectedPlanId === livePlanId}
              onClick={() => void changePlan()}
              className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Updating…" : "Apply plan"}
            </button>
            {subscription?.subscription && !pendingCancel ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void cancelSubscription()}
                className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-40"
              >
                Cancel at period end
              </button>
            ) : null}
          </div>
          {actionError ? (
            <p className="mt-2 text-xs text-red-400">{actionError}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Payment history
          </h3>
          <label className="flex items-center gap-2 text-[11px] text-zinc-500">
            <input
              type="checkbox"
              checked={cycleOnly}
              onChange={(event) => setCycleOnly(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-700 bg-black/20"
            />
            This cycle only
          </label>
        </div>
        {visibleInvoices.length === 0 ? (
          <p className="rounded-lg border border-white/[0.04] px-3 py-4 text-sm text-zinc-500">
            {invoices.length === 0
              ? "No invoices or payments for this identity yet."
              : "No invoices overlap this billing cycle."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-white/[0.06]">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="px-3 py-2 text-left font-medium">Invoice</th>
                  <th className="px-3 py-2 text-left font-medium">Issued</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium"> </th>
                </tr>
              </thead>
              <tbody>
                {visibleInvoices.map((invoice) => (
                  <tr
                    key={invoice.id}
                    className="border-b border-white/[0.04] last:border-b-0"
                  >
                    <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                      {invoice.number || invoice.id}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-400">
                      {invoice.issuedAt
                        ? formatBillingUtcDate(invoice.issuedAt, { year: "numeric" })
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-zinc-200">
                      {invoice.currency?.toUpperCase() === "USD" || !invoice.currency
                        ? `$${invoice.totalAmount}`
                        : `${invoice.totalAmount} ${invoice.currency}`}
                    </td>
                    <td className="px-3 py-2 text-[11px] uppercase tracking-wider text-zinc-500">
                      {invoice.status}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => void openInvoice(invoice.id)}
                        className="text-xs text-emerald-400 hover:text-emerald-300"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
