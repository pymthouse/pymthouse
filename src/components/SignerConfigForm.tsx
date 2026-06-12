"use client";

import { useState } from "react";
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

function fieldInputClass(locked: boolean, mono = false): string {
  const base = locked
    ? "bg-zinc-900/50 border-zinc-800 text-zinc-400 cursor-not-allowed"
    : "bg-zinc-800/50 border-zinc-700 text-zinc-200 focus:outline-none focus:border-emerald-500/50";
  return `w-full px-3 py-2 border rounded-lg text-sm ${mono ? "font-mono text-xs" : ""} ${base}`;
}

const LOCAL_ONLY_FIELD_HELP =
  "Only used when starting the local Docker signer from this app. Configure on Railway for remote deployments.";

export default function SignerConfigForm({ config }: SignerConfigFormProps) {
  const router = useRouter();
  const signerUrlEnvLocked = config.signerUrlSource === "env";
  const localComposeLocked = config.managedRemote;
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const skipSignerUrlPersist =
        signerUrlEnvLocked ||
        (!config.signerUrl &&
          formData.signerUrl === config.effectiveSignerUrl);
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
        setMessage(data.message || "Config saved");
        router.refresh();
      } else {
        setError(data.error || "Failed to save config");
      }
    } catch {
      setError("Failed to connect to API");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="mb-8 pb-8 border-b border-zinc-800">
        <h3 className="font-semibold text-zinc-200 mb-1">
          OIDC / JWKS (automatic)
        </h3>
        <p className="text-xs text-zinc-500 mb-4">
          Values passed into the local signer-dmz stack: issuer and audience are
          <code className="text-zinc-400"> getIssuer()</code> (from{" "}
          <code className="text-zinc-400">NEXTAUTH_URL</code> /{" "}
          <code className="text-zinc-400">OIDC_ISSUER</code>). JWKS is that issuer
          plus <code className="text-zinc-400">/jwks</code>, with loopback rewritten
          for the container. Override JWKS with{" "}
          <code className="text-zinc-400">SIGNER_DMZ_JWKS_URL</code>.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-xs text-zinc-500 mb-1.5">
              OIDC_ISSUER
            </label>
            <div className="w-full px-3 py-2 bg-zinc-900/50 border border-zinc-800 rounded-lg text-xs text-zinc-300 font-mono break-all">
              {config.oidcIssuer}
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">
              OIDC_AUDIENCE
            </label>
            <div className="w-full px-3 py-2 bg-zinc-900/50 border border-zinc-800 rounded-lg text-xs text-zinc-300 font-mono break-all">
              {config.oidcAudience}
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">
              JWKS_URI
            </label>
            <div className="w-full px-3 py-2 bg-zinc-900/50 border border-zinc-800 rounded-lg text-xs text-zinc-300 font-mono break-all">
              {config.oidcJwksUrl}
            </div>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <h3 className="font-semibold text-zinc-200">Saved settings</h3>
        {localComposeLocked && (
          <p className="text-xs text-zinc-500">
            Platform billing fields are saved here. Signer process settings (RPC,
            port, discovery) are managed on the remote host.
          </p>
        )}

        <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-0 p-0 m-0 min-w-0">
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">
            Signer Name
          </label>
          <input
            type="text"
            required
            value={formData.name}
            onChange={(e) =>
              setFormData({ ...formData, name: e.target.value })
            }
            className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">
            Signer Base URL
          </label>
          <input
            type="url"
            value={formData.signerUrl}
            onChange={(e) =>
              setFormData({ ...formData, signerUrl: e.target.value })
            }
            disabled={signerUrlEnvLocked}
            readOnly={signerUrlEnvLocked}
            className={fieldInputClass(signerUrlEnvLocked)}
            placeholder={config.effectiveSignerUrl}
          />
          <p className="text-xs text-zinc-600 mt-0.5">
            {signerUrlEnvLocked ? (
              <>
                Locked by{" "}
                <code className="text-zinc-500">SIGNER_INTERNAL_URL</code> in
                the server environment (Vercel / Railway). Change it in the
                deployment dashboard, not here.
              </>
            ) : (
              <>
                Effective signer HTTP base URL (
                {config.signerUrlSource === "saved"
                  ? "saved in database"
                  : "default fallback"}
                ). This must point to Apache/DMZ on the host, usually{" "}
                <code className="text-zinc-500">http://127.0.0.1:8080</code>.
                Do not use livepeer&apos;s in-container{" "}
                <code className="text-zinc-500">127.0.0.1:8081</code> here.
              </>
            )}
          </p>
          {signerUrlEnvLocked &&
            config.signerUrl &&
            config.signerUrl.trim() !== config.effectiveSignerUrl && (
              <p className="text-xs text-amber-600/80 mt-1">
                Database has{" "}
                <code className="text-amber-500/90">{config.signerUrl}</code> but
                it is ignored while{" "}
                <code className="text-amber-500/90">SIGNER_INTERNAL_URL</code> is
                set.
              </p>
            )}
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">
            Signer Port (httpAddr)
          </label>
          <input
            type="number"
            min="1024"
            max="65535"
            value={formData.signerPort}
            onChange={(e) =>
              setFormData({
                ...formData,
                signerPort: parseInt(e.target.value, 10) || 8080,
              })
            }
            disabled={localComposeLocked}
            readOnly={localComposeLocked}
            className={fieldInputClass(localComposeLocked)}
          />
          <p className="text-xs text-zinc-600 mt-0.5">
            {localComposeLocked
              ? LOCAL_ONLY_FIELD_HELP
              : "Host port mapped to Apache in signer-dmz (default 8080). Do not use 8081 here: that is livepeer’s in-container HTTP port, not published on the host. Set SIGNER_INTERNAL_URL in .env if this row is wrong. Restart signer after changing."}
          </p>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">
            Network
          </label>
          <div className="w-full px-3 py-2 bg-zinc-900/50 border border-zinc-800 rounded-lg text-sm text-zinc-300">
            arbitrum-one-mainnet
          </div>
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-zinc-500 mb-1.5">
            Ethereum RPC URL
          </label>
          <input
            type="url"
            required={!localComposeLocked}
            value={formData.ethRpcUrl}
            onChange={(e) =>
              setFormData({ ...formData, ethRpcUrl: e.target.value })
            }
            disabled={localComposeLocked}
            readOnly={localComposeLocked}
            className={fieldInputClass(localComposeLocked, true)}
            placeholder="https://arb1.arbitrum.io/rpc"
          />
          {localComposeLocked && (
            <p className="text-xs text-zinc-600 mt-0.5">{LOCAL_ONLY_FIELD_HELP}</p>
          )}
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-zinc-500 mb-1.5">
            Signer API Key
          </label>
          <input
            type="text"
            value={formData.signerApiKey}
            onChange={(e) =>
              setFormData({ ...formData, signerApiKey: e.target.value })
            }
            className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:border-emerald-500/50 font-mono text-xs"
            placeholder="Optional shared secret for the remote signer"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-zinc-500 mb-1.5">
            Eth Account Address
          </label>
          <input
            type="text"
            value={formData.ethAcctAddr}
            onChange={(e) =>
              setFormData({ ...formData, ethAcctAddr: e.target.value })
            }
            disabled={localComposeLocked}
            readOnly={localComposeLocked}
            className={fieldInputClass(localComposeLocked, true)}
            placeholder="0x..."
          />
          {localComposeLocked && (
            <p className="text-xs text-zinc-600 mt-0.5">{LOCAL_ONLY_FIELD_HELP}</p>
          )}
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">
            Platform Cut (%)
          </label>
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={formData.defaultCutPercent}
            onChange={(e) =>
              setFormData({
                ...formData,
                defaultCutPercent: parseFloat(e.target.value),
              })
            }
            className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1.5">
            Billing Mode
          </label>
          <select
            value={formData.billingMode}
            onChange={(e) =>
              setFormData({ ...formData, billingMode: e.target.value })
            }
            className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
          >
            <option value="delegated">Delegated</option>
            <option value="prepay">Prepay</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-xs text-zinc-500 mb-1.5">
            <input
              type="checkbox"
              checked={formData.remoteDiscovery}
              disabled={localComposeLocked}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  remoteDiscovery: e.target.checked,
                  orchWebhookUrl: e.target.checked ? formData.orchWebhookUrl : "",
                  liveAICapReportInterval: e.target.checked
                    ? formData.liveAICapReportInterval
                    : "",
                })
              }
              className="rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/50 disabled:opacity-50"
            />
            Remote Discovery (orchWebhookUrl + liveAICapReportInterval)
          </label>
          {localComposeLocked && (
            <p className="text-xs text-zinc-600 mt-1">{LOCAL_ONLY_FIELD_HELP}</p>
          )}
        </div>
        {formData.remoteDiscovery && !localComposeLocked && (
          <>
            <div className="sm:col-span-2">
              <label className="block text-xs text-zinc-500 mb-1.5">
                Orch Webhook URL
              </label>
              <input
                type="url"
                value={formData.orchWebhookUrl}
                onChange={(e) =>
                  setFormData({ ...formData, orchWebhookUrl: e.target.value })
                }
                className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:border-emerald-500/50 font-mono text-xs"
                placeholder="https://example.com/orch-info.json"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">
                Live AI Cap Report Interval
              </label>
              <input
                type="text"
                value={formData.liveAICapReportInterval}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    liveAICapReportInterval: e.target.value,
                  })
                }
                className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:border-emerald-500/50 font-mono text-xs"
                placeholder="5m"
              />
              <p className="text-xs text-zinc-600 mt-0.5">
                e.g. 5m, 10s, 1h
              </p>
            </div>
          </>
        )}
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-emerald-500 text-white rounded-lg text-sm font-medium hover:bg-emerald-600 transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Config"}
        </button>

        {message && (
          <span className="text-sm text-amber-400">{message}</span>
        )}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </form>
    </>
  );
}
