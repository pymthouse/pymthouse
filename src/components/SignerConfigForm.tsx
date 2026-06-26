"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SignerConfigFormProps {
  config: {
    name: string;
    signerUrl?: string | null;
    signerApiKey?: string | null;
    network: string;
    ethRpcUrl: string;
    ethAcctAddr: string | null;
    signerPort: number;
    defaultCutPercent: number;
    billingMode: string;
    remoteDiscovery: number;
    orchWebhookUrl: string | null;
    liveAICapReportInterval: string | null;
    /** Public platform OIDC issuer + JWKS (not loopback — see issuer-urls). */
    oidcIssuer: string;
    oidcAudience: string;
    oidcJwksUrl: string;
    /** The signer HTTP base URL that PymtHouse will call after DB/env/default resolution. */
    effectiveSignerUrl: string;
    signerUrlSource: "saved" | "env" | "default";
    /** Signer DMZ is deployed off this host (Railway, etc.). */
    managedRemote: boolean;
  };
}

function FormField({
  label,
  help,
  warning,
  children,
  colSpan2 = false,
  fieldId,
}: Readonly<{
  label: string;
  help?: React.ReactNode;
  warning?: React.ReactNode;
  children: React.ReactNode;
  colSpan2?: boolean;
  fieldId: string;
}>) {
  return (
    <div className={colSpan2 ? "sm:col-span-2" : ""}>
      <label
        htmlFor={fieldId}
        className="block text-sm font-medium text-zinc-300 mb-1.5"
      >
        {label}
      </label>
      {children}
      {help && <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">{help}</p>}
      {warning && <p className="text-xs text-amber-500/90 mt-1.5 leading-relaxed">{warning}</p>}
    </div>
  );
}

function ReadonlyField({
  id,
  value,
  mono = false,
}: Readonly<{
  id: string;
  value: string;
  mono?: boolean;
}>) {
  return (
    <input
      id={id}
      type="text"
      readOnly
      value={value}
      className={`w-full px-3 py-2 bg-zinc-900/50 border border-zinc-800 rounded-lg text-sm text-zinc-300 break-all select-all cursor-default ${mono ? "font-mono text-xs" : ""}`}
    />
  );
}

const inputBase =
  "w-full px-3 py-2 border rounded-lg text-sm focus:outline-none transition-colors";
const inputEnabled = `${inputBase} bg-zinc-800/50 border-zinc-700 text-zinc-200 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20`;
const inputDisabled = `${inputBase} bg-zinc-900/50 border-zinc-800 text-zinc-400 cursor-not-allowed`;

function fieldClass(locked: boolean, mono = false) {
  return `${locked ? inputDisabled : inputEnabled} ${mono ? "font-mono text-xs" : ""}`;
}

const LOCAL_ONLY_HELP =
  "Only used when starting the local Docker signer from this app. Configure on Railway for remote deployments.";

export default function SignerConfigForm({ config }: Readonly<SignerConfigFormProps>) {
  const router = useRouter();
  const signerUrlEnvLocked = config.signerUrlSource === "env";
  const localComposeLocked = config.managedRemote;
  const saveStateResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "success" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    return () => {
      if (saveStateResetTimerRef.current !== null) {
        clearTimeout(saveStateResetTimerRef.current);
      }
    };
  }, []);

  const [formData, setFormData] = useState({
    name: config.name,
    signerUrl: signerUrlEnvLocked
      ? config.effectiveSignerUrl
      : config.signerUrl || config.effectiveSignerUrl,
    signerApiKey: config.signerApiKey || "",
    network: config.network,
    ethRpcUrl: config.ethRpcUrl,
    ethAcctAddr: config.ethAcctAddr || "",
    signerPort: config.signerPort,
    defaultCutPercent: config.defaultCutPercent,
    billingMode: config.billingMode,
    remoteDiscovery: config.remoteDiscovery === 1,
    orchWebhookUrl: config.orchWebhookUrl || "",
    liveAICapReportInterval: config.liveAICapReportInterval || "5m",
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saveStateResetTimerRef.current !== null) {
      clearTimeout(saveStateResetTimerRef.current);
      saveStateResetTimerRef.current = null;
    }
    setSaving(true);
    setSaveState("idle");
    setSaveMessage(null);

    try {
      const skipSignerUrlPersist =
        signerUrlEnvLocked ||
        (!config.signerUrl && formData.signerUrl === config.effectiveSignerUrl);
      const signerUrl = skipSignerUrlPersist ? undefined : formData.signerUrl;
      const res = await fetch("/api/v1/signer", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          defaultCutPercent: formData.defaultCutPercent,
          billingMode: formData.billingMode,
          signerApiKey: formData.signerApiKey || null,
          network: "arbitrum-one-mainnet",
          ...(signerUrl !== undefined ? { signerUrl } : {}),
          ...(localComposeLocked
            ? {}
            : {
                ethRpcUrl: formData.ethRpcUrl,
                ethAcctAddr: formData.ethAcctAddr || null,
                signerPort: formData.signerPort,
                remoteDiscovery: formData.remoteDiscovery,
                orchWebhookUrl: formData.remoteDiscovery
                  ? formData.orchWebhookUrl || null
                  : null,
                liveAICapReportInterval: formData.remoteDiscovery
                  ? formData.liveAICapReportInterval || null
                  : null,
              }),
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setSaveState("success");
        setSaveMessage(data.message || "Configuration saved.");
        router.refresh();
        saveStateResetTimerRef.current = setTimeout(() => {
          saveStateResetTimerRef.current = null;
          setSaveState("idle");
        }, 4000);
      } else {
        setSaveState("error");
        setSaveMessage(data.error || "Failed to save configuration.");
      }
    } catch {
      setSaveState("error");
      setSaveMessage("Failed to connect to API.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* OIDC / JWKS — read-only */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
        <h3 className="text-sm font-semibold text-zinc-100 mb-0.5">
          OIDC / JWKS
        </h3>
        <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
          Passed into the local signer-dmz stack. Issuer and audience come from{" "}
          <code className="text-zinc-400">NEXTAUTH_URL</code> /{" "}
          <code className="text-zinc-400">OIDC_ISSUER</code>. Override JWKS with{" "}
          <code className="text-zinc-400">SIGNER_DMZ_JWKS_URL</code>.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label htmlFor="signer-oidc-issuer" className="block text-sm font-medium text-zinc-400 mb-1.5">
              OIDC_ISSUER
            </label>
            <ReadonlyField id="signer-oidc-issuer" value={config.oidcIssuer} mono />
          </div>
          <div>
            <label htmlFor="signer-oidc-audience" className="block text-sm font-medium text-zinc-400 mb-1.5">
              OIDC_AUDIENCE
            </label>
            <ReadonlyField id="signer-oidc-audience" value={config.oidcAudience} mono />
          </div>
          <div>
            <label htmlFor="signer-oidc-jwks" className="block text-sm font-medium text-zinc-400 mb-1.5">
              JWKS_URI
            </label>
            <ReadonlyField id="signer-oidc-jwks" value={config.oidcJwksUrl} mono />
          </div>
        </div>
      </section>

      {/* Editable config */}
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">
            Saved settings
          </h3>
          {localComposeLocked && (
            <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-2 py-0.5">
              Remote managed
            </span>
          )}
        </div>

        {localComposeLocked && (
          <p className="text-xs text-zinc-500 -mt-2">
            Platform billing fields are saved here. Signer process settings (RPC,
            port, discovery) are managed on the remote host.
          </p>
        )}

        {/* Identity & Connection */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 space-y-4">
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Identity &amp; Connection
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Signer Name" fieldId="signer-name">
              <input
                id="signer-name"
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className={inputEnabled}
              />
            </FormField>

            <FormField label="Network" fieldId="signer-network">
              <ReadonlyField id="signer-network" value="arbitrum-one-mainnet" />
            </FormField>

            <FormField
              label="Signer Base URL"
              fieldId="signer-base-url"
              colSpan2
              help={
                signerUrlEnvLocked ? (
                  <>
                    Locked by <code className="text-zinc-400">SIGNER_INTERNAL_URL</code>{" "}
                    in the server environment. Change it in the deployment dashboard.
                  </>
                ) : (
                  <>
                    HTTP base URL for Apache/DMZ on the host. Use{" "}
                    <code className="text-zinc-400">http://127.0.0.1:8080</code>{" "}
                    (not livepeer&apos;s in-container{" "}
                    <code className="text-zinc-400">:8081</code>).
                  </>
                )
              }
              warning={
                signerUrlEnvLocked &&
                config.signerUrl &&
                config.signerUrl.trim() !== config.effectiveSignerUrl ? (
                  <>
                    Database has{" "}
                    <code className="text-amber-500/90">{config.signerUrl}</code> but
                    it is ignored while{" "}
                    <code className="text-amber-500/90">SIGNER_INTERNAL_URL</code> is set.
                  </>
                ) : undefined
              }
            >
              <input
                id="signer-base-url"
                type="url"
                value={formData.signerUrl}
                onChange={(e) => setFormData({ ...formData, signerUrl: e.target.value })}
                disabled={signerUrlEnvLocked}
                readOnly={signerUrlEnvLocked}
                className={fieldClass(signerUrlEnvLocked)}
                placeholder={config.effectiveSignerUrl}
              />
            </FormField>

            <FormField
              label="Signer API Key"
              fieldId="signer-api-key"
              colSpan2
              help="Optional shared secret sent to the remote signer for request authentication."
            >
              <div className="relative">
                <input
                  id="signer-api-key"
                  type={showApiKey ? "text" : "password"}
                  value={formData.signerApiKey}
                  onChange={(e) => setFormData({ ...formData, signerApiKey: e.target.value })}
                  className={`${inputEnabled} pr-10 font-mono text-xs`}
                  placeholder="Optional — leave blank to disable"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-zinc-500 hover:text-zinc-300 transition-colors"
                  aria-label={showApiKey ? "Hide API key" : "Show API key"}
                >
                  {showApiKey ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </FormField>
          </div>
        </div>

        {/* Network & Process */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 space-y-4">
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Network &amp; Process
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField
              label="Ethereum RPC URL"
              fieldId="signer-eth-rpc-url"
              colSpan2
              help={localComposeLocked ? LOCAL_ONLY_HELP : undefined}
            >
              <input
                id="signer-eth-rpc-url"
                type="url"
                required={!localComposeLocked}
                value={formData.ethRpcUrl}
                onChange={(e) => setFormData({ ...formData, ethRpcUrl: e.target.value })}
                disabled={localComposeLocked}
                readOnly={localComposeLocked}
                className={fieldClass(localComposeLocked, true)}
                placeholder="https://arb1.arbitrum.io/rpc"
              />
            </FormField>

            <FormField
              label="Eth Account Address"
              fieldId="signer-eth-acct-addr"
              colSpan2
              help={localComposeLocked ? LOCAL_ONLY_HELP : undefined}
            >
              <input
                id="signer-eth-acct-addr"
                type="text"
                value={formData.ethAcctAddr}
                onChange={(e) => setFormData({ ...formData, ethAcctAddr: e.target.value })}
                disabled={localComposeLocked}
                readOnly={localComposeLocked}
                className={fieldClass(localComposeLocked, true)}
                placeholder="0x..."
              />
            </FormField>

            <FormField
              label="Signer Port (httpAddr)"
              fieldId="signer-port"
              help={
                localComposeLocked
                  ? LOCAL_ONLY_HELP
                  : "Host port mapped to Apache in signer-dmz (default 8080). Restart signer after changing."
              }
            >
              <input
                id="signer-port"
                type="number"
                min="1024"
                max="65535"
                value={formData.signerPort}
                onChange={(e) =>
                  setFormData({ ...formData, signerPort: Number.parseInt(e.target.value, 10) || 8080 })
                }
                disabled={localComposeLocked}
                readOnly={localComposeLocked}
                className={fieldClass(localComposeLocked)}
              />
            </FormField>
          </div>
        </div>

        {/* Billing */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 space-y-4">
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Billing
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Platform Cut (%)" fieldId="signer-platform-cut">
              <input
                id="signer-platform-cut"
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={formData.defaultCutPercent}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    defaultCutPercent: Number.parseFloat(e.target.value) || 0,
                  })
                }
                className={inputEnabled}
              />
            </FormField>

            <FormField label="Billing Mode" fieldId="signer-billing-mode">
              <select
                id="signer-billing-mode"
                value={formData.billingMode}
                onChange={(e) => setFormData({ ...formData, billingMode: e.target.value })}
                className={inputEnabled}
              >
                <option value="delegated">Delegated</option>
                <option value="prepay">Prepay</option>
              </select>
            </FormField>
          </div>
        </div>

        {/* Discovery */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 space-y-4">
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Discovery
          </h4>
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={formData.remoteDiscovery}
              disabled={localComposeLocked}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  remoteDiscovery: e.target.checked,
                  orchWebhookUrl: e.target.checked ? formData.orchWebhookUrl : "",
                  liveAICapReportInterval: e.target.checked ? formData.liveAICapReportInterval : "",
                })
              }
              className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/50 disabled:opacity-50 cursor-pointer"
            />
            <div>
              <span className="text-sm font-medium text-zinc-200 group-hover:text-zinc-100 transition-colors">
                Remote Discovery
              </span>
              <p className="text-xs text-zinc-500 mt-0.5">
                Enables orchestrator webhook and live AI capability reporting.
              </p>
              {localComposeLocked && (
                <p className="text-xs text-zinc-600 mt-1">{LOCAL_ONLY_HELP}</p>
              )}
            </div>
          </label>

          {formData.remoteDiscovery && !localComposeLocked && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-zinc-800/60">
              <FormField
                label="Orch Webhook URL"
                fieldId="signer-orch-webhook-url"
                colSpan2
              >
                <input
                  id="signer-orch-webhook-url"
                  type="url"
                  value={formData.orchWebhookUrl}
                  onChange={(e) => setFormData({ ...formData, orchWebhookUrl: e.target.value })}
                  className={`${inputEnabled} font-mono text-xs`}
                  placeholder="https://example.com/orch-info.json"
                />
              </FormField>

              <FormField
                label="Live AI Cap Report Interval"
                fieldId="signer-live-ai-cap-interval"
                help="Duration string, e.g. 5m, 10s, 1h"
              >
                <input
                  id="signer-live-ai-cap-interval"
                  type="text"
                  value={formData.liveAICapReportInterval}
                  onChange={(e) =>
                    setFormData({ ...formData, liveAICapReportInterval: e.target.value })
                  }
                  className={`${inputEnabled} font-mono text-xs`}
                  placeholder="5m"
                />
              </FormField>
            </div>
          )}
        </div>

        {/* Save row */}
        <div className="flex items-center gap-4 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Saving…
              </>
            ) : (
              "Save configuration"
            )}
          </button>

          {saveState === "success" && saveMessage && (
            <span className="flex items-center gap-1.5 text-sm text-emerald-400">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {saveMessage}
            </span>
          )}
          {saveState === "error" && saveMessage && (
            <span className="flex items-center gap-1.5 text-sm text-red-400">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {saveMessage}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
