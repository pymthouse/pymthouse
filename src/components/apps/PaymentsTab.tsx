"use client";

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  sanitizeUsdCentsInput,
  usdCentsDisplayToMicros,
  usdMicrosToCentsDisplay,
} from "@/lib/format-usd-micros";
import { paymentsTabErrorMessage } from "@/lib/stripe/payments-tab-errors";

type ActivationInfo = {
  clientId: string;
  billingMode: "owner_rollup" | "merchant";
  connectReady: boolean;
  canProvisionEndUsers: boolean;
  canSellPaidPlans: boolean;
  reason: string | null;
  endUserCap: number;
  appUserCount: number;
};

type StripeStatus = {
  status: string;
  billingReady?: boolean;
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
  billingMode?: "owner_rollup" | "merchant";
  endUserCap?: number;
  activation?: ActivationInfo | null;
  supplierCountry?: string | null;
  supplierName?: string | null;
  supplierTaxId?: string | null;
  supplierTaxIdRequired?: boolean;
  supplierTaxIdOnFileAtStripe?: boolean;
  supplierGaps?: string[];
  supplierComplete?: boolean;
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

function PaymentsActivationBanner({
  activation,
}: Readonly<{ activation: ActivationInfo }>) {
  const modeLabel =
    activation.billingMode === "merchant" ? "merchant" : "owner roll-up";
  const sellHint = activation.connectReady
    ? "Switch billing mode to merchant to unlock paid plan checkout."
    : "Connect Stripe and complete onboarding to sell paid plans.";
  const provisionHint =
    activation.reason === "end_user_cap_reached"
      ? "End-user cap reached — raise the cap or switch to merchant mode."
      : "Owner wallet has no spendable balance — top up credits to provision more users.";

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2">
      <h3 className="text-sm font-semibold text-amber-950">Activation</h3>
      <p className="text-sm text-amber-900">
        Mode: <span className="font-mono">{modeLabel}</span>
        {" · "}
        Provision end users: {activation.canProvisionEndUsers ? "allowed" : "blocked"}
        {" · "}
        Sell paid plans: {activation.canSellPaidPlans ? "allowed" : "blocked"}
        {" · "}
        Users {activation.appUserCount}/{activation.endUserCap}
      </p>
      {!activation.canSellPaidPlans && (
        <p className="text-sm text-amber-900">{sellHint}</p>
      )}
      {!activation.canProvisionEndUsers && (
        <p className="text-sm text-amber-900">{provisionHint}</p>
      )}
    </div>
  );
}

function applyStatusToForm(
  nextStatus: StripeStatus,
  set: {
    progressiveBilling: (v: boolean) => void;
    billingMode: (v: "owner_rollup" | "merchant") => void;
    thresholdDisplay: (v: string) => void;
    supplierTaxId: (v: string) => void;
  },
): void {
  set.progressiveBilling(nextStatus.progressiveBilling ?? true);
  set.billingMode(nextStatus.billingMode === "merchant" ? "merchant" : "owner_rollup");
  set.thresholdDisplay(
    nextStatus.invoiceThresholdUsdMicros
      ? usdMicrosToCentsDisplay(nextStatus.invoiceThresholdUsdMicros)
      : "",
  );
  set.supplierTaxId(nextStatus.supplierTaxId?.trim() || "");
}

function parseThresholdMicros(display: string): string | null {
  const trimmed = display.trim();
  if (trimmed === "") {
    return null;
  }
  const micros = usdCentsDisplayToMicros(trimmed);
  if (micros == null) {
    throw new Error("Invoice threshold must be a valid dollar amount");
  }
  return micros;
}

function connectUiFlags(status: StripeStatus | null) {
  const hasAccount = Boolean(status?.stripeConnectedAccountId?.trim());
  // Match backend isConnectReady: charges + details submitted.
  const merchantReady =
    hasAccount &&
    Boolean(status?.stripeChargesEnabled) &&
    Boolean(status?.stripeDetailsSubmitted);
  const pendingOnboarding = hasAccount && !merchantReady;
  const hasLegacyOmLink = Boolean(
    status?.openmeterStripeAppId || status?.openmeterBillingProfileId,
  );
  return {
    hasAccount,
    merchantReady,
    pendingOnboarding,
    hasLegacyOmLink,
    canDisconnect: hasAccount || hasLegacyOmLink,
  };
}

function connectBadgeClass(flags: ReturnType<typeof connectUiFlags>): string {
  if (flags.merchantReady) return "bg-green-100 text-green-800";
  if (flags.pendingOnboarding) return "bg-amber-100 text-amber-900";
  return "bg-gray-100 text-gray-700";
}

function connectBadgeLabel(
  flags: ReturnType<typeof connectUiFlags>,
  fallbackStatus: string | undefined,
): string {
  if (flags.hasAccount) {
    return flags.merchantReady ? "connected" : "pending";
  }
  if (flags.hasLegacyOmLink) {
    return "needs merchant connect";
  }
  return fallbackStatus ?? "disconnected";
}

type BusySetters = {
  setBusy: (v: boolean) => void;
  setError: (v: string | null) => void;
};

async function postConnectRedirect(
  url: string,
  init: RequestInit,
  setters: BusySetters,
  failLabel: string,
): Promise<void> {
  setters.setBusy(true);
  setters.setError(null);
  try {
    const res = await fetch(url, init);
    const body = await res.json();
    if (!res.ok || !body.url) {
      throw new Error(body.error || failLabel);
    }
    redirectToStripeConnectUrl(body.url);
  } catch (err) {
    setters.setError(err instanceof Error ? err.message : String(err));
    setters.setBusy(false);
  }
}

async function requestDisconnectStripe(
  appId: string,
  setters: BusySetters,
  reload: () => Promise<void>,
): Promise<void> {
  if (!globalThis.confirm("Disconnect Stripe from this app?")) {
    return;
  }
  setters.setBusy(true);
  setters.setError(null);
  try {
    const res = await fetch(`/api/v1/apps/${appId}/billing/stripe`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error || "Disconnect failed");
    }
    await reload();
  } catch (err) {
    setters.setError(err instanceof Error ? err.message : String(err));
  } finally {
    setters.setBusy(false);
  }
}

async function requestSaveBillingSettings(input: {
  appId: string;
  progressiveBilling: boolean;
  thresholdDisplay: string;
  billingMode: "owner_rollup" | "merchant";
  supplierTaxId: string;
  setters: BusySetters & {
    setSettingsSaved: (v: string | null) => void;
    setStatus: Dispatch<SetStateAction<StripeStatus | null>>;
  };
}): Promise<void> {
  const { setters } = input;
  setters.setBusy(true);
  setters.setError(null);
  setters.setSettingsSaved(null);
  try {
    const invoiceThresholdUsdMicros = parseThresholdMicros(input.thresholdDisplay);
    const payload: Record<string, unknown> = {
      progressiveBilling: input.progressiveBilling,
      invoiceThresholdUsdMicros,
      billingMode: input.billingMode,
    };
    // Always send when Connect is linked so merchant switch can satisfy tax_id
    // gaps in the same PATCH as billingMode.
    if (input.supplierTaxId.trim() || input.billingMode === "merchant") {
      payload.supplierTaxId = input.supplierTaxId.trim() || null;
    }
    const res = await fetch(`/api/v1/apps/${input.appId}/billing/stripe`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) {
      const gaps =
        Array.isArray(body.supplierGaps) && body.supplierGaps.length > 0
          ? ` Missing: ${body.supplierGaps.join(", ")}.`
          : "";
      throw new Error(`${body.error || "Failed to save billing settings"}${gaps}`);
    }
    setters.setStatus((prev) => (prev ? { ...prev, ...body } : body));
    setters.setSettingsSaved("Saved");
  } catch (err) {
    setters.setError(err instanceof Error ? err.message : String(err));
  } finally {
    setters.setBusy(false);
  }
}

function PaymentsInvoicesList({ invoices }: Readonly<{ invoices: InvoiceRow[] }>) {
  if (invoices.length === 0) {
    return <p className="text-sm text-muted-foreground">No customer invoices yet.</p>;
  }
  return (
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
  );
}

export default function PaymentsTab({ appId, canManageBilling }: Readonly<Props>) {
  const [status, setStatus] = useState<StripeStatus | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressiveBilling, setProgressiveBilling] = useState(true);
  const [thresholdDisplay, setThresholdDisplay] = useState("");
  const [billingMode, setBillingMode] = useState<"owner_rollup" | "merchant">(
    "owner_rollup",
  );
  const [supplierTaxId, setSupplierTaxId] = useState("");
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
      applyStatusToForm(nextStatus, {
        progressiveBilling: setProgressiveBilling,
        billingMode: setBillingMode,
        thresholdDisplay: setThresholdDisplay,
        supplierTaxId: setSupplierTaxId,
      });
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
    if (globalThis.window === undefined) {
      void load().catch(() => undefined);
      return;
    }
    const params = new URLSearchParams(globalThis.location.search);
    const errorCode = params.get("error");
    if (errorCode) {
      setError(
        paymentsTabErrorMessage(errorCode) ??
          "Stripe Connect returned an error. Try again.",
      );
    }
    // Single load: return-from-onboarding and initial mount share one fetch.
    void load().catch(() => undefined);
  }, [load]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading payments…</p>;
  }

  return (
    <PaymentsTabLoaded
      appId={appId}
      canManageBilling={canManageBilling}
      status={status}
      invoices={invoices}
      error={error}
      busy={busy}
      progressiveBilling={progressiveBilling}
      thresholdDisplay={thresholdDisplay}
      billingMode={billingMode}
      supplierTaxId={supplierTaxId}
      settingsSaved={settingsSaved}
      setBusy={setBusy}
      setError={setError}
      setStatus={setStatus}
      setSettingsSaved={setSettingsSaved}
      setBillingMode={setBillingMode}
      setSupplierTaxId={setSupplierTaxId}
      setProgressiveBilling={setProgressiveBilling}
      setThresholdDisplay={setThresholdDisplay}
      reload={load}
    />
  );
}

function PaymentsConnectActions(props: Readonly<{
  appId: string;
  busy: boolean;
  flags: ReturnType<typeof connectUiFlags>;
  busySetters: BusySetters;
  reload: () => Promise<void>;
}>) {
  const { appId, busy, flags, busySetters, reload } = props;
  return (
    <div className="flex flex-wrap gap-2">
      {!flags.hasAccount && (
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          disabled={busy}
          onClick={() =>
            void postConnectRedirect(
              `/api/v1/apps/${appId}/billing/stripe/connect`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: "account_link" }),
              },
              busySetters,
              "Connect failed",
            )
          }
        >
          Complete onboarding
        </button>
      )}
      {flags.pendingOnboarding && (
        <button
          type="button"
          className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          disabled={busy}
          onClick={() =>
            void postConnectRedirect(
              `/api/v1/apps/${appId}/billing/stripe/account-link`,
              { method: "POST" },
              busySetters,
              "Account Link failed",
            )
          }
        >
          Refresh Account Link
        </button>
      )}
      {flags.canDisconnect && (
        <button
          type="button"
          className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          disabled={busy}
          onClick={() => void requestDisconnectStripe(appId, busySetters, reload)}
        >
          Disconnect
        </button>
      )}
    </div>
  );
}

function PaymentsBillingModeForm(props: Readonly<{
  busy: boolean;
  billingMode: "owner_rollup" | "merchant";
  connectReadyForMerchant: boolean;
  supplierTaxId: string;
  supplierTaxIdRequired: boolean;
  settingsSaved: string | null;
  setBillingMode: (v: "owner_rollup" | "merchant") => void;
  setSupplierTaxId: (v: string) => void;
  onSave: () => void;
}>) {
  const {
    busy,
    billingMode,
    connectReadyForMerchant,
    supplierTaxId,
    supplierTaxIdRequired,
    settingsSaved,
    setBillingMode,
    setSupplierTaxId,
    onSave,
  } = props;
  const showTaxId =
    connectReadyForMerchant &&
    (supplierTaxIdRequired || billingMode === "merchant");
  return (
    <div className="pt-2 border-t space-y-3">
      <label className="block text-sm">
        <span className="text-muted-foreground">Billing mode</span>
        <select
          className="mt-1 w-full max-w-xs rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-bright/30"
          value={billingMode}
          onChange={(e) =>
            setBillingMode(e.target.value === "merchant" ? "merchant" : "owner_rollup")
          }
          disabled={busy}
        >
          <option value="owner_rollup">Owner roll-up (default)</option>
          <option value="merchant" disabled={!connectReadyForMerchant}>
            Merchant (requires Connect ready)
          </option>
        </select>
      </label>
      {showTaxId ? (
        <label className="block text-sm">
          <span className="text-muted-foreground">
            Supplier tax ID
            {supplierTaxIdRequired ? " (required for invoices)" : " (optional)"}
          </span>
          <input
            type="text"
            className="mt-1 w-full max-w-xs rounded-md border bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-bright/30"
            value={supplierTaxId}
            onChange={(e) => setSupplierTaxId(e.target.value)}
            disabled={busy}
            placeholder="e.g. VAT / EIN"
            autoComplete="off"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Stripe does not share the verified tax ID — enter the value that should
            appear on customer invoices.
          </span>
        </label>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          disabled={busy}
          onClick={onSave}
        >
          Save billing settings
        </button>
        {settingsSaved ? (
          <span className="text-xs text-emerald-600">{settingsSaved}</span>
        ) : null}
      </div>
    </div>
  );
}

function PaymentsProgressiveBillingForm(props: Readonly<{
  canManageBilling: boolean;
  busy: boolean;
  progressiveBilling: boolean;
  thresholdDisplay: string;
  settingsSaved: string | null;
  setProgressiveBilling: (v: boolean) => void;
  setThresholdDisplay: (v: string) => void;
  setSettingsSaved: (v: string | null) => void;
  onSave: () => void;
}>) {
  const {
    canManageBilling,
    busy,
    progressiveBilling,
    thresholdDisplay,
    settingsSaved,
    setProgressiveBilling,
    setThresholdDisplay,
    setSettingsSaved,
    onSave,
  } = props;
  return (
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
            onClick={onSave}
          >
            Save invoicing settings
          </button>
          {settingsSaved ? (
            <span className="text-xs text-emerald-600">{settingsSaved}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PaymentsStatusDetails({ status }: Readonly<{ status: StripeStatus | null }>) {
  return (
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
        <dt className="text-muted-foreground">Invoice supplier</dt>
        <dd>
          {[status?.supplierName, status?.supplierCountry].filter(Boolean).join(" · ") ||
            "—"}
          {status?.supplierComplete === false ? (
            <span className="ml-1 text-amber-800">
              (incomplete
              {status.supplierGaps?.length
                ? `: ${status.supplierGaps.join(", ")}`
                : ""}
              )
            </span>
          ) : null}
        </dd>
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
  );
}

function PaymentsTabLoaded(props: Readonly<{
  appId: string;
  canManageBilling: boolean;
  status: StripeStatus | null;
  invoices: InvoiceRow[];
  error: string | null;
  busy: boolean;
  progressiveBilling: boolean;
  thresholdDisplay: string;
  billingMode: "owner_rollup" | "merchant";
  supplierTaxId: string;
  settingsSaved: string | null;
  setBusy: (v: boolean) => void;
  setError: (v: string | null) => void;
  setStatus: Dispatch<SetStateAction<StripeStatus | null>>;
  setSettingsSaved: (v: string | null) => void;
  setBillingMode: (v: "owner_rollup" | "merchant") => void;
  setSupplierTaxId: (v: string) => void;
  setProgressiveBilling: (v: boolean) => void;
  setThresholdDisplay: (v: string) => void;
  reload: () => Promise<void>;
}>) {
  const {
    appId,
    canManageBilling,
    status,
    invoices,
    error,
    busy,
    progressiveBilling,
    thresholdDisplay,
    billingMode,
    supplierTaxId,
    settingsSaved,
    setBusy,
    setError,
    setStatus,
    setSettingsSaved,
    setBillingMode,
    setSupplierTaxId,
    setProgressiveBilling,
    setThresholdDisplay,
    reload,
  } = props;

  const flags = connectUiFlags(status);
  const busySetters = { setBusy, setError };
  const connectReadyForMerchant = flags.merchantReady;
  const save = () =>
    void requestSaveBillingSettings({
      appId,
      progressiveBilling,
      thresholdDisplay,
      billingMode,
      supplierTaxId,
      setters: { setBusy, setError, setSettingsSaved, setStatus },
    });
  const showDetails =
    flags.hasAccount || flags.hasLegacyOmLink || Boolean(status?.connectedAt);

  return (
    <div className="space-y-6">
      {status?.activation && (
        <PaymentsActivationBanner activation={status.activation} />
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">Merchant Stripe Connect</h3>
            <p className="text-sm text-muted-foreground">
              Collect from your end users on a Stripe Connected Account (Plane B).
              OpenMeter Stripe billing (Plane A) meters usage and invoices you for
              network cost separately. Complete Stripe-hosted onboarding (Account Links)
              to create and verify your Connected Account.
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2 py-1 rounded ${connectBadgeClass(flags)}`}
          >
            {connectBadgeLabel(flags, status?.status)}
          </span>
        </div>

        {showDetails && <PaymentsStatusDetails status={status} />}

        {canManageBilling && (
          <PaymentsConnectActions
            appId={appId}
            busy={busy}
            flags={flags}
            busySetters={busySetters}
            reload={reload}
          />
        )}

        {canManageBilling && (
          <PaymentsBillingModeForm
            busy={busy}
            billingMode={billingMode}
            connectReadyForMerchant={connectReadyForMerchant}
            supplierTaxId={supplierTaxId}
            supplierTaxIdRequired={Boolean(status?.supplierTaxIdRequired)}
            settingsSaved={settingsSaved}
            setBillingMode={setBillingMode}
            setSupplierTaxId={setSupplierTaxId}
            onSave={save}
          />
        )}
      </div>

      {flags.merchantReady && (
        <PaymentsProgressiveBillingForm
          canManageBilling={canManageBilling}
          busy={busy}
          progressiveBilling={progressiveBilling}
          thresholdDisplay={thresholdDisplay}
          settingsSaved={settingsSaved}
          setProgressiveBilling={setProgressiveBilling}
          setThresholdDisplay={setThresholdDisplay}
          setSettingsSaved={setSettingsSaved}
          onSave={save}
        />
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
        <PaymentsInvoicesList invoices={invoices} />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
