"use client";

import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";

interface AppSettingsData {
  appId: string;
  clientId: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  initiateLoginUri: string | null;
  tokenEndpointAuthMethod: string;
  hasSecret: boolean;
  domains: { id: string; domain: string }[];
}

interface Props {
  data: AppSettingsData;
}

export default function AppSettingsPanel({ data }: Props) {
  const [redirectUris, setRedirectUris] = useState<string[]>(data.redirectUris);
  const [postLogoutRedirectUris, setPostLogoutRedirectUris] = useState<string[]>(
    data.postLogoutRedirectUris || [],
  );
  const [initiateLoginUri, setInitiateLoginUri] = useState<string>(data.initiateLoginUri || "");
  const [tokenEndpointAuthMethod, setTokenEndpointAuthMethod] = useState(data.tokenEndpointAuthMethod);
  const [domains, setDomains] = useState(data.domains || []);
  const [newRedirectUri, setNewRedirectUri] = useState("");
  const [newPostLogoutUri, setNewPostLogoutUri] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const discoveryUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/.well-known/openid-configuration`
      : "";
  const authorizeUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/v1/oidc/authorize`
      : "";
  const tokenUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/v1/oidc/token`
      : "";
  const signerSessionUrl =
    typeof window !== "undefined" && data.clientId
      ? `${window.location.origin}/api/v1/apps/${encodeURIComponent(data.clientId)}/oidc/token`
      : "";

  const addValue = (
    value: string,
    setValue: (nextValue: string) => void,
    setItems: Dispatch<SetStateAction<string[]>>,
  ) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setItems((items) => (items.includes(trimmed) ? items : [...items, trimmed]));
    setValue("");
  };

  const saveSettings = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${data.appId}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirectUris,
          postLogoutRedirectUris,
          initiateLoginUri: initiateLoginUri.trim() || null,
          tokenEndpointAuthMethod,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to save settings");
      setMessage("Settings saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const rotateSecret = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${data.appId}/credentials`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to rotate secret");
      setSecret(body.clientSecret);
      setTokenEndpointAuthMethod("client_secret_post");
      setMessage("Client secret rotated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const addDomain = async () => {
    const domain = newDomain.trim();
    if (!domain) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${data.appId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to add domain");
      setDomains((currentDomains) => [...currentDomains, body]);
      setNewDomain("");
      setMessage("Domain added");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const removeDomain = async (domainId: string) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${data.appId}/domains?domainId=${encodeURIComponent(domainId)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove domain");
      setDomains((currentDomains) => currentDomains.filter((domain) => domain.id !== domainId));
      setMessage("Domain removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">OIDC Settings</h2>
          <p className="text-sm text-zinc-500 mt-1">
            Minimal runtime configuration for redirect handling and credential management.
          </p>
        </div>

        <div>
          <label htmlFor="settings-new-redirect-uri" className="block text-sm font-medium text-zinc-300 mb-1.5">
            Redirect URIs
          </label>
          <div className="flex gap-2 mb-2">
            <input
              id="settings-new-redirect-uri"
              type="text"
              value={newRedirectUri}
              onChange={(event) => setNewRedirectUri(event.target.value)}
              onKeyDown={(event) =>
                event.key === "Enter" &&
                (event.preventDefault(), addValue(newRedirectUri, setNewRedirectUri, setRedirectUris))
              }
              placeholder="https://example.com/callback"
              className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100"
            />
            <button
              type="button"
              onClick={() => addValue(newRedirectUri, setNewRedirectUri, setRedirectUris)}
              className="px-4 py-2 rounded-lg bg-zinc-700 text-zinc-200 text-sm hover:bg-zinc-600 transition-colors"
            >
              Add
            </button>
          </div>
          <div className="space-y-2">
            {redirectUris.map((uri) => (
              <div key={uri} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-800/40 px-3 py-2">
                <code className="text-xs text-zinc-300">{uri}</code>
                <button
                  type="button"
                  onClick={() => setRedirectUris((items) => items.filter((item) => item !== uri))}
                  className="text-xs text-zinc-500 hover:text-red-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="settings-new-post-logout-uri" className="block text-sm font-medium text-zinc-300 mb-1.5">
            Post-logout Redirect URIs
          </label>
          <div className="flex gap-2 mb-2">
            <input
              id="settings-new-post-logout-uri"
              type="text"
              value={newPostLogoutUri}
              onChange={(event) => setNewPostLogoutUri(event.target.value)}
              onKeyDown={(event) =>
                event.key === "Enter" &&
                (event.preventDefault(), addValue(newPostLogoutUri, setNewPostLogoutUri, setPostLogoutRedirectUris))
              }
              placeholder="https://example.com/logout-complete"
              className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100"
            />
            <button
              type="button"
              onClick={() => addValue(newPostLogoutUri, setNewPostLogoutUri, setPostLogoutRedirectUris)}
              className="px-4 py-2 rounded-lg bg-zinc-700 text-zinc-200 text-sm hover:bg-zinc-600 transition-colors"
            >
              Add
            </button>
          </div>
          <div className="space-y-2">
            {postLogoutRedirectUris.map((uri) => (
              <div key={uri} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-800/40 px-3 py-2">
                <code className="text-xs text-zinc-300">{uri}</code>
                <button
                  type="button"
                  onClick={() => setPostLogoutRedirectUris((items) => items.filter((item) => item !== uri))}
                  className="text-xs text-zinc-500 hover:text-red-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="settings-initiate-login-uri" className="block text-sm font-medium text-zinc-300 mb-1.5">
              Initiate Login URI
            </label>
            <input
              id="settings-initiate-login-uri"
              type="url"
              value={initiateLoginUri}
              onChange={(event) => setInitiateLoginUri(event.target.value)}
              placeholder="https://example.com/login"
              className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100"
            />
          </div>
          <div>
            <label htmlFor="settings-token-auth-method" className="block text-sm font-medium text-zinc-300 mb-1.5">
              Token Auth Method
            </label>
            <select
              id="settings-token-auth-method"
              value={tokenEndpointAuthMethod}
              onChange={(event) => setTokenEndpointAuthMethod(event.target.value)}
              className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100"
            >
              <option value="none">Public (PKCE)</option>
              <option value="client_secret_post">client_secret_post</option>
              <option value="client_secret_basic">client_secret_basic</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={saveSettings}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50"
          >
            Save Settings
          </button>
          <button
            type="button"
            onClick={rotateSecret}
            disabled={saving}
            className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-200 text-sm hover:bg-zinc-800 disabled:opacity-50"
          >
            {data.hasSecret ? "Rotate Secret" : "Generate Secret"}
          </button>
        </div>

        {secret && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-xs text-amber-300 mb-2">New client secret</p>
            <code className="text-xs text-amber-200 break-all">{secret}</code>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Allowed Domains</h2>
          <p className="text-sm text-zinc-500 mt-1">
            CORS and browser origins permitted for this provider app.
          </p>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={newDomain}
            onChange={(event) => setNewDomain(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && (event.preventDefault(), addDomain())}
            placeholder="https://app.example.com"
            className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-sm text-zinc-100"
          />
          <button
            type="button"
            onClick={addDomain}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-zinc-700 text-zinc-200 text-sm hover:bg-zinc-600 disabled:opacity-50"
          >
            Add
          </button>
        </div>

        <div className="space-y-2">
          {domains.map((domain) => (
            <div key={domain.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-800/40 px-3 py-2">
              <code className="text-xs text-zinc-300">{domain.domain}</code>
              <button
                type="button"
                onClick={() => removeDomain(domain.id)}
                className="text-xs text-zinc-500 hover:text-red-400"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Reference Endpoints</h2>
        </div>
        <Field label="Client ID" value={data.clientId} />
        <Field label="OIDC Discovery" value={discoveryUrl} />
        <Field label="Authorize" value={authorizeUrl} />
        <Field label="OIDC token" value={tokenUrl} />
        <Field label="Signer session exchange" value={signerSessionUrl} />
      </section>

      {(message || error) && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            error
              ? "border-red-500/20 bg-red-500/10 text-red-300"
              : "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
          }`}
        >
          {error || message}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="block text-xs font-medium text-zinc-500 mb-1.5">{label}</div>
      <code className="block rounded-lg border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-xs text-zinc-300 break-all">
        {value}
      </code>
    </div>
  );
}
