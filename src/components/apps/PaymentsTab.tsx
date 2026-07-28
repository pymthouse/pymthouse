"use client";

import { useCallback, useEffect, useState } from "react";
import {
  sanitizeUsdCentsInput,
  usdCentsDisplayToMicros,
  usdMicrosToCentsDisplay,
} from "@/lib/format-usd-micros";
import { paymentsTabErrorMessage } from "@/lib/stripe/payments-tab-errors";

type StripeStatus = {
  status: string;
  openmeterStripeAppId: string | null;
  openmeterBillingProfileId: string | null;
  defaultCurrency: string;
  connectedAt: string | null;
  progressiveBilling?: boolean;
  invoiceThresholdUsdMicros?: string | null;
  stripeConnectedAccountId?: string | null;
  stripeOnboardingMethod?: string | null;
  stripeChargesEnabled?: boolean;
  stripePayoutsEnabled?: boolean;
  stripeDetailsSubmitted?: boolean;
  applicationFeeBps?: number;
  connectPaymentsOnly?: boolean;
};

type InvoiceRow = {
  id: string;
  number?: string;
  status: string;
  currency: string;
  totalAmount: string;
  issuedAt?: string;
  customerKey?: string;
};

type Props = {
  appId: string;
  canManageBilling: boolean;
};

/** Only allow redirect to Stripe-hosted Connect / Account Link URLs. */
function redirectToStripeConnectUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid Connect URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Invalid Connect URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "connect.stripe.com" && !host.endsWith(".stripe.com")) {
    throw new Error("Connect URL must be a Stripe host");
  }
  // Rebuild from validated host + URL-parser path/query (no open redirect).
  globalThis.location.assign(
    `https://${host}${parsed.pathname}${parsed.search}${parsed.hash}`,
  );
}

export default function PaymentsTab({ appId, canManageBilling }: Readonly<Props>) {
  const [status, setStatus] = useState<StripeStatus | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applicationFeeBps, setApplicationFeeBps] = useState("0");
  const [progressiveBilling, setProgressiveBilling] = useState(true);
  const [thresholdDisplay, setThresholdDisplay] = useState("");
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null);

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
      const nextStatus = (await statusRes.json()) as StripeStatus;
      setStatus(nextStatus);
      setProgressiveBilling(nextStatus.progressiveBilling ?? true);
      setApplicationFeeBps(String(nextStatus.applicationFeeBps ?? 0));
      setThresholdDisplay(
        nextStatus.invoiceThresholdUsdMicros
          ? usdMicrosToCentsDisplay(nextStatus.invoiceThresholdUsdMicros)
          : "",
      );
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
      if (params.get("error")) {
        setError(paymentsTabErrorMessage(params.get("error")));
      }
      if (params.get("connected") === "1" || params.get("connect") === "refresh") {
        load().catch(() => undefined);
      }
    }
  }, [load]);

  async function startMerchantOnboarding() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/billing/stripe/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "account_link" }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Connect failed");
      }
      if (!body.url) {
        throw new Error(body.error || "Connect URL missing");
      }
      redirectToStripeConnectUrl(body.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function refreshAccountLink() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/apps/${appId}/billing/stripe/account-link`,
        { method: "POST" },
      );
      const body = await res.json();
      if (!res.ok || !body.url) {
        throw new Error(body.error || "Account Link failed");
      }
      redirectToStripeConnectUrl(body.url);
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

  async function saveBillingProfileSettings() {
    setBusy(true);
    setError(null);
    setSettingsSaved(null);
    try {
      const trimmed = thresholdDisplay.trim();
      let invoiceThresholdUsdMicros: string | null = null;
      if (trimmed !== "") {
        const micros = usdCentsDisplayToMicros(trimmed);
        if (micros == null) {
          throw new Error("Invoice threshold must be a valid dollar amount");
        }
        invoiceThresholdUsdMicros = micros;
      }
      const res = await fetch(`/api/v1/apps/${appId}/billing/stripe`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          progressiveBilling,
          invoiceThresholdUsdMicros,
          applicationFeeBps: Number.parseInt(applicationFeeBps, 10) || 0,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to save billing settings");
      }
      setStatus((prev) => (prev ? { ...prev, ...body } : body));
      setSettingsSaved("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading payments…</p>;
  }

  const hasAccount = Boolean(status?.stripeConnectedAccountId?.trim());
  /** Merchant Connect ready (acct_… + charges). Not legacy OM Stripe-app install. */
  const merchantReady =
    hasAccount && Boolean(status?.stripeChargesEnabled);
  const pendingOnboarding = hasAccount && !merchantReady;
  const hasLegacyOmLink = Boolean(
    status?.openmeterStripeAppId || status?.openmeterBillingProfileId,
  );
  /** Allow clearing legacy OM link and/or merchant Connect account. */
  const canDisconnect = hasAccount || hasLegacyOmLink;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">Stripe Connect</h3>
            <p className="text-sm text-muted-foreground">
              OpenMeter meters usage and subscriptions. End-user payments go through your
              merchant Connected Account (direct charges). Complete Stripe-hosted onboarding
              (Account Links) to create and verify your Connected Account.
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2 py-1 rounded ${
              merchantReady
                ? "bg-green-100 text-green-800"
                : pendingOnboarding
                  ? "bg-amber-100 text-amber-900"
                  : "bg-gray-100 text-gray-700"
            }`}
          >
            {hasAccount
              ? merchantReady
                ? "connected"
                : "pending"
              : hasLegacyOmLink
                ? "needs merchant connect"
                : (status?.status ?? "disconnected")}
          </span>
        </div>

        {(hasAccount || hasLegacyOmLink || status?.connectedAt) && (
          <dl className="text-sm grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <dt className="text-muted-foreground">Connected account</dt>
              <dd className="font-mono text-xs break-all">
                {status?.stripeConnectedAccountId ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Onboarding</dt>
              <dd>{status?.stripeOnboardingMethod ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Charges</dt>
              <dd>{status?.stripeChargesEnabled ? "Enabled" : "Paused / pending"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Payouts</dt>
              <dd>{status?.stripePayoutsEnabled ? "Enabled" : "Paused / pending"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">OM billing profile</dt>
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
          <div className="flex flex-wrap gap-2">
            {!hasAccount && (
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                disabled={busy}
                onClick={() => void startMerchantOnboarding()}
              >
                Complete onboarding
              </button>
            )}
            {pendingOnboarding && (
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                disabled={busy}
                onClick={() => void refreshAccountLink()}
              >
                Refresh Account Link
              </button>
            )}
            {canDisconnect && (
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                disabled={busy}
                onClick={() => void disconnectStripe()}
              >
                Disconnect
              </button>
            )}
          </div>
        )}

        {canManageBilling && (
          <div className="pt-2 border-t space-y-3">
            <label className="block text-sm">
              <span className="text-muted-foreground">Platform application fee (bps)</span>
              <input
                type="number"
                min={0}
                max={10000}
                className="mt-1 w-40 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-bright/30"
                value={applicationFeeBps}
                onChange={(e) => setApplicationFeeBps(e.target.value)}
                disabled={busy}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              100 bps = 1%. Applied on Connect payment intents / invoices.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                disabled={busy}
                onClick={() => void saveBillingProfileSettings()}
              >
                Save billing settings
              </button>
              {settingsSaved ? (
                <span className="text-xs text-emerald-600">{settingsSaved}</span>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {merchantReady && (
        <div className="rounded-lg border p-4 space-y-3">
          <div>
            <h3 className="text-base font-semibold">Mid-cycle invoicing</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Progressive billing allows OpenMeter to invoice unpaid usage before the
              billing cycle ends. Set an optional dollar threshold; the clearinghouse
              worker charges when gathering invoices reach that amount.
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={progressiveBilling}
              disabled={!canManageBilling || busy}
              onChange={(e) => {
                setProgressiveBilling(e.target.checked);
                setSettingsSaved(null);
              }}
            />
            <span>
              Enable progressive billing
              <span className="block text-xs text-muted-foreground">
                Synced to this app&apos;s OpenMeter billing profile.
              </span>
            </span>
          </label>
          <div>
            <label htmlFor="invoice-threshold" className="block text-xs text-muted-foreground mb-1">
              Invoice when unpaid usage reaches (USD)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <input
                id="invoice-threshold"
                type="text"
                inputMode="decimal"
                placeholder="e.g. 10.00 (leave blank to disable)"
                disabled={!canManageBilling || busy || !progressiveBilling}
                value={thresholdDisplay}
                onChange={(e) => {
                  setThresholdDisplay(sanitizeUsdCentsInput(e.target.value));
                  setSettingsSaved(null);
                }}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-bright/30 disabled:opacity-50"
              />
            </div>
          </div>
          {canManageBilling && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                disabled={busy}
                onClick={() => void saveBillingProfileSettings()}
              >
                Save invoicing settings
              </button>
              {settingsSaved ? (
                <span className="text-xs text-emerald-600">{settingsSaved}</span>
              ) : null}
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <div>
          <h3 className="text-base font-semibold">Customer invoices</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            End users billed through this app&apos;s Stripe Connect account. Platform invoices
            for your developer prepaid wallet are on{" "}
            <a href="/billing" className="text-emerald-500 hover:text-emerald-400">
              Billing
            </a>
            .
          </p>
        </div>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No customer invoices yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {invoices.map((inv) => (
              <li key={inv.id} className="py-2 flex justify-between gap-4">
                <div className="min-w-0">
                  <span className="font-mono">{inv.number ?? inv.id}</span>
                  {inv.customerKey ? (
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {inv.customerKey}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0">
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
