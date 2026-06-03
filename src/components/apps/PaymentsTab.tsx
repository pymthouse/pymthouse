"use client";

import { useCallback, useEffect, useState } from "react";

type StripeStatus = {
  status: string;
  openmeterStripeAppId: string | null;
  openmeterBillingProfileId: string | null;
  defaultCurrency: string;
  connectedAt: string | null;
};

type InvoiceRow = {
  id: string;
  number?: string;
  status: string;
  currency: string;
  totalAmount: string;
  issuedAt?: string;
};

type Props = {
  appId: string;
  canManageBilling: boolean;
};

export default function PaymentsTab({ appId, canManageBilling }: Readonly<Props>) {
  const [status, setStatus] = useState<StripeStatus | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showApiKeyForm, setShowApiKeyForm] = useState(false);
  const [stripeSecretKey, setStripeSecretKey] = useState("");
  const [apiKeyHint, setApiKeyHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, invoicesRes] = await Promise.all([
        fetch(`/api/v1/apps/${appId}/billing/stripe`),
        fetch(`/api/v1/apps/${appId}/billing/invoices?pageSize=10`),
      ]);
      if (!statusRes.ok) {
        throw new Error("Failed to load billing status");
      }
      setStatus(await statusRes.json());
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
    if (globalThis.window !== undefined) {
      const params = new URLSearchParams(globalThis.location.search);
      const oauthError = params.get("error");
      if (oauthError) {
        setError(oauthError);
      }
      if (params.get("connected") === "1") {
        void load();
      }
    }
  }, [load]);

  async function connectStripe() {
    setBusy(true);
    setError(null);
    setApiKeyHint(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/billing/stripe/connect`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Connect failed");
      }
      if (body.method === "api_key") {
        setShowApiKeyForm(true);
        setApiKeyHint(body.message ?? null);
        setBusy(false);
        return;
      }
      if (!body.url) {
        throw new Error(body.error || "Connect failed");
      }
      globalThis.location.href = body.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function connectStripeWithApiKey() {
    const key = stripeSecretKey.trim();
    if (!key) {
      setError("Enter a Stripe secret key");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/billing/stripe/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stripeSecretKey: key }),
      });
      const body = await res.json();
      if (!res.ok || !body.connected) {
        throw new Error(body.error || "Connect failed");
      }
      setStripeSecretKey("");
      setShowApiKeyForm(false);
      setApiKeyHint(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading payments…</p>;
  }

  const connected = status?.status === "connected";

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

        {canManageBilling && showApiKeyForm && !connected && (
          <div className="rounded-md border border-dashed p-3 space-y-2 bg-muted/30">
            <p className="text-sm text-muted-foreground">
              {apiKeyHint ??
                "Paste a restricted secret key (sk_live_… or sk_test_…) from the Stripe Dashboard for this merchant account."}
            </p>
            <label className="block text-sm">
              <span className="text-muted-foreground">Stripe secret key</span>
              <input
                type="password"
                autoComplete="off"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-bright/30"
                value={stripeSecretKey}
                onChange={(e) => setStripeSecretKey(e.target.value)}
                placeholder="sk_live_…"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                disabled={busy}
                onClick={() => void connectStripeWithApiKey()}
              >
                Save Stripe key
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  setShowApiKeyForm(false);
                  setStripeSecretKey("");
                  setApiKeyHint(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-lg border p-4 space-y-3">
        <h3 className="text-base font-semibold">Recent invoices</h3>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {invoices.map((inv) => (
              <li key={inv.id} className="py-2 flex justify-between gap-4">
                <span className="font-mono">{inv.number ?? inv.id}</span>
                <span>
                  {inv.totalAmount} {inv.currency} · {inv.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
