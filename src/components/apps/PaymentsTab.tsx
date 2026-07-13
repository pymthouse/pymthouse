"use client";

import { useCallback, useEffect, useState } from "react";

type StripeStatus = {
  status: string;
  openmeterStripeAppId: string | null;
  openmeterBillingProfileId: string | null;
  defaultCurrency: string;
  checkoutSuccessUrl: string | null;
  checkoutCancelUrl: string | null;
  taxBehavior: "inclusive" | "exclusive" | null;
  connectedAt: string | null;
};

type InvoiceRow = {
  id: string;
  number?: string;
  status: string;
  currency: string;
  totalAmount: string;
  issuedAt?: string;
  periodStart?: string;
  periodEnd?: string;
  customerKey?: string;
  customerId?: string;
  lines?: Array<{
    id?: string;
    name?: string;
    total?: string;
    quantity?: string;
  }>;
};

type Props = {
  appId: string;
  canManageBilling: boolean;
};

export default function PaymentsTab({ appId, canManageBilling }: Readonly<Props>) {
  const [status, setStatus] = useState<StripeStatus | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [successUrl, setSuccessUrl] = useState("");
  const [cancelUrl, setCancelUrl] = useState("");
  const [taxBehavior, setTaxBehavior] = useState<"" | "inclusive" | "exclusive">("");
  const [grantUserId, setGrantUserId] = useState("");
  const [grantAmount, setGrantAmount] = useState("5.00");
  const [grantSource, setGrantSource] = useState("promo");
  const [grantExpiresAfter, setGrantExpiresAfter] = useState("P90D");
  const [portalUserId, setPortalUserId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, invoicesRes] = await Promise.all([
        fetch(`/api/v1/apps/${appId}/billing/stripe`),
        fetch(`/api/v1/apps/${appId}/billing/invoices?pageSize=10&include=lines`),
      ]);
      if (!statusRes.ok) {
        throw new Error("Failed to load billing status");
      }
      const statusBody = await statusRes.json();
      setStatus(statusBody);
      setSuccessUrl(statusBody.checkoutSuccessUrl ?? "");
      setCancelUrl(statusBody.checkoutCancelUrl ?? "");
      setTaxBehavior(statusBody.taxBehavior ?? "");
      if (invoicesRes.ok) {
        const body = await invoicesRes.json();
        setInvoices(body.items ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  async function connectStripe() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/billing/stripe/connect`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok || !body.url) {
        throw new Error(body.error || "Connect failed");
      }
      globalThis.location.href = body.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function disconnectStripe() {
    if (!globalThis.confirm("Disconnect Stripe from this app?")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/billing/stripe`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Disconnect failed");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveCheckoutSettings() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/billing/stripe`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSuccessUrl: successUrl.trim() || null,
          checkoutCancelUrl: cancelUrl.trim() || null,
          taxBehavior: taxBehavior || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to save checkout settings");
      }
      setStatus(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openPortal() {
    const externalUserId = portalUserId.trim();
    if (!externalUserId) {
      setError("Enter an external user id for the Stripe portal");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/billing/portal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalUserId }),
      });
      const body = await res.json();
      if (!res.ok || !body.portalUrl) {
        throw new Error(body.error || "Portal session failed");
      }
      globalThis.open(body.portalUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function grantCredits() {
    const externalUserId = grantUserId.trim();
    if (!externalUserId) {
      setError("Enter an external user id to grant credits");
      return;
    }
    const dollars = Number(grantAmount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError("Grant amount must be a positive USD amount");
      return;
    }
    const amountUsdMicros = String(Math.round(dollars * 1_000_000));
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/apps/${appId}/users/${encodeURIComponent(externalUserId)}/allowances`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amountUsdMicros,
            source: grantSource,
            expiresAfter: grantExpiresAfter.trim() || undefined,
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Grant failed");
      }
      setGrantAmount("5.00");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading payments…</p>;
  }

  const connected = status?.status === "connected";
  const selectedInvoice = invoices.find((inv) => inv.id === selectedInvoiceId) ?? null;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">Stripe Connect</h3>
            <p className="text-sm text-muted-foreground">
              Connect your Stripe account to bill end users via OpenMeter.
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2 py-1 rounded ${
              connected ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-700"
            }`}
          >
            {status?.status ?? "disconnected"}
          </span>
        </div>

        {connected && (
          <dl className="text-sm grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <dt className="text-muted-foreground">Billing profile</dt>
              <dd className="font-mono text-xs break-all">
                {status?.openmeterBillingProfileId ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Connected</dt>
              <dd>{status?.connectedAt ?? "—"}</dd>
            </div>
          </dl>
        )}

        {canManageBilling && (
          <div className="flex gap-2">
            {connected ? (
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                disabled={busy}
                onClick={() => void disconnectStripe()}
              >
                Disconnect
              </button>
            ) : (
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                disabled={busy}
                onClick={() => void connectStripe()}
              >
                Connect Stripe
              </button>
            )}
          </div>
        )}
      </div>

      {canManageBilling && (
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-base font-semibold">Checkout &amp; tax settings</h3>
          <p className="text-sm text-muted-foreground">
            Default return URLs for Stripe Checkout and preferred tax behavior.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm space-y-1">
              <span className="text-muted-foreground">Success URL</span>
              <input
                value={successUrl}
                onChange={(e) => setSuccessUrl(e.target.value)}
                placeholder="https://example.com/billing/success"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm space-y-1">
              <span className="text-muted-foreground">Cancel URL</span>
              <input
                value={cancelUrl}
                onChange={(e) => setCancelUrl(e.target.value)}
                placeholder="https://example.com/billing/cancel"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm space-y-1">
              <span className="text-muted-foreground">Tax behavior</span>
              <select
                value={taxBehavior}
                onChange={(e) =>
                  setTaxBehavior(e.target.value as "" | "inclusive" | "exclusive")
                }
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">Provider default</option>
                <option value="inclusive">Inclusive</option>
                <option value="exclusive">Exclusive</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            disabled={busy}
            onClick={() => void saveCheckoutSettings()}
          >
            Save settings
          </button>
        </div>
      )}

      {canManageBilling && connected && (
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-base font-semibold">Stripe customer portal</h3>
          <p className="text-sm text-muted-foreground">
            Open a portal session so an end user can manage payment methods and invoices.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={portalUserId}
              onChange={(e) => setPortalUserId(e.target.value)}
              placeholder="externalUserId"
              className="rounded-md border px-3 py-2 text-sm min-w-[220px]"
            />
            <button
              type="button"
              className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
              disabled={busy}
              onClick={() => void openPortal()}
            >
              Open portal
            </button>
          </div>
        </div>
      )}

      {canManageBilling && (
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-base font-semibold">Credit grants</h3>
          <p className="text-sm text-muted-foreground">
            Grant promo or manual USD credits to an end user (OpenMeter / Konnect).
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              value={grantUserId}
              onChange={(e) => setGrantUserId(e.target.value)}
              placeholder="externalUserId"
              className="rounded-md border px-3 py-2 text-sm"
            />
            <input
              value={grantAmount}
              onChange={(e) => setGrantAmount(e.target.value)}
              placeholder="USD amount"
              className="rounded-md border px-3 py-2 text-sm"
            />
            <select
              value={grantSource}
              onChange={(e) => setGrantSource(e.target.value)}
              className="rounded-md border px-3 py-2 text-sm"
            >
              <option value="promo">promo</option>
              <option value="manual">manual</option>
              <option value="plan_adjustment">plan_adjustment</option>
              <option value="trial">trial</option>
            </select>
            <input
              value={grantExpiresAfter}
              onChange={(e) => setGrantExpiresAfter(e.target.value)}
              placeholder="Expires after (ISO-8601, e.g. P90D)"
              className="rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
            disabled={busy}
            onClick={() => void grantCredits()}
          >
            Grant credits
          </button>
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <h3 className="text-base font-semibold">Recent invoices</h3>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {invoices.map((inv) => (
              <li key={inv.id} className="py-2">
                <button
                  type="button"
                  className="w-full flex justify-between gap-4 text-left hover:opacity-80"
                  onClick={() =>
                    setSelectedInvoiceId((prev) => (prev === inv.id ? null : inv.id))
                  }
                >
                  <span className="font-mono">{inv.number ?? inv.id}</span>
                  <span>
                    {inv.totalAmount} {inv.currency} · {inv.status}
                  </span>
                </button>
                {selectedInvoice?.id === inv.id && (
                  <div className="mt-2 rounded-md bg-muted/40 p-3 space-y-1 text-xs">
                    <p>
                      Period: {inv.periodStart ?? "—"} → {inv.periodEnd ?? "—"}
                    </p>
                    <p>Customer: {inv.customerKey ?? inv.customerId ?? "—"}</p>
                    <p>Issued: {inv.issuedAt ?? "—"}</p>
                    {(inv.lines?.length ?? 0) > 0 && (
                      <ul className="mt-2 space-y-1">
                        {inv.lines?.map((line, idx) => (
                          <li key={line.id ?? `${inv.id}-line-${idx}`}>
                            {line.name ?? "Line"} · {line.total ?? "0"}{" "}
                            {line.quantity ? `× ${line.quantity}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
