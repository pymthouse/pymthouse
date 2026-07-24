"use client";

import { useId, useState } from "react";
import DomainAllowlistBlock, { parseDomainError } from "./DomainAllowlistBlock";

interface Props {
  appId: string | null;
  redirectUris: string[];
  onRedirectUrisChange: (uris: string[]) => void;
  domains: { id: string; domain: string }[];
  onDomainsChange: (domains: { id: string; domain: string }[]) => void;
  readOnly?: boolean;
  /** When true, the last redirect URI cannot be removed (confidential web clients). */
  requireAtLeastOne?: boolean;
  /**
   * When false, skip PUT `{ redirectUris }` to the public client — parent persists
   * (e.g. confidential `web_` via `confidentialWebRedirectUris`). Domain allowlist
   * still uses `appId` when set.
   */
  persistRedirectUrisToPublicClient?: boolean;
  /**
   * When false, omit the domain allowlist editor (render it once at the Public tab).
   * Redirect adds still auto-whitelist origins when `appId` is set.
   */
  showDomains?: boolean;
  /** Optional label override (e.g. portal vs public redirects). */
  label?: string;
  /** Optional help text override. */
  description?: string;
}

export default function AuthorizationCodeRedirectBlock({
  appId,
  redirectUris,
  onRedirectUrisChange,
  domains,
  onDomainsChange,
  readOnly = false,
  requireAtLeastOne = false,
  persistRedirectUrisToPublicClient = true,
  showDomains = true,
  label = "Redirect URIs",
  description,
}: Readonly<Props>) {
  const inputId = useId();
  const [newUri, setNewUri] = useState("");
  const [redirectPersistError, setRedirectPersistError] = useState<string | null>(null);
  const [redirectSaving, setRedirectSaving] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);

  const persistRedirectUris = async (nextUris: string[]) => {
    if (readOnly) return false;
    if (!appId || !persistRedirectUrisToPublicClient) return true;
    setRedirectSaving(true);
    setRedirectPersistError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirectUris: nextUris }),
      });
      if (!res.ok) {
        const text = await res.text();
        let message = `Failed to save redirect URIs (${res.status})`;
        try {
          const data = text ? JSON.parse(text) : {};
          if (data.error) message = data.error;
        } catch {
          /* keep generic */
        }
        setRedirectPersistError(message);
        return false;
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setRedirectPersistError(`Failed to save redirect URIs: ${message}`);
      return false;
    } finally {
      setRedirectSaving(false);
    }
  };

  const autoWhitelistOrigin = async (uri: string) => {
    if (!appId) return;
    let normalizedOrigin: string;
    try {
      const origin = new URL(uri).origin;
      if (origin === "null") return;
      normalizedOrigin = origin.toLowerCase();
    } catch {
      /* invalid URL or wildcard — skip auto-whitelist */
      return;
    }

    if (domains.some((d) => d.domain.toLowerCase() === normalizedOrigin)) return;

    setDomainError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: normalizedOrigin }),
      });
      if (!res.ok) {
        setDomainError(await parseDomainError(res));
        return;
      }
      const resData = await res.json();
      onDomainsChange([...domains, { id: resData.id, domain: resData.domain }]);
    } catch (err) {
      console.error("Failed to auto-whitelist redirect URI domain.", err);
      setDomainError(
        err instanceof Error ? err.message : "Could not auto-whitelist redirect URI domain.",
      );
    }
  };

  const addRedirectUri = async () => {
    if (readOnly) return;
    const uri = newUri.trim();
    if (!uri || redirectUris.includes(uri)) return;
    const previous = redirectUris;
    const next = [...redirectUris, uri];
    onRedirectUrisChange(next);
    setNewUri("");

    if (appId) {
      const ok = await persistRedirectUris(next);
      if (!ok) {
        onRedirectUrisChange(previous);
        return;
      }
      await autoWhitelistOrigin(uri);
    }
  };

  const removeRedirectUri = async (uri: string) => {
    if (readOnly) return;
    if (requireAtLeastOne && redirectUris.length <= 1) return;
    const previous = redirectUris;
    const next = redirectUris.filter((u) => u !== uri);
    onRedirectUrisChange(next);
    if (appId) {
      const ok = await persistRedirectUris(next);
      if (!ok) onRedirectUrisChange(previous);
    }
  };

  const helpText =
    description ??
    `URIs where PymtHouse can redirect after authorization. Wildcards (*) are supported.${
      appId
        ? " Each add or remove is saved immediately."
        : " Save the app first, then add URIs here."
    }`;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label htmlFor={inputId} className="block text-sm font-medium text-zinc-300">
          {label}
        </label>
        <p className="text-xs text-zinc-500">{helpText}</p>
        {redirectPersistError && (
          <p className="text-xs text-red-400">{redirectPersistError}</p>
        )}
        {domainError && !showDomains ? (
          <p className="text-xs text-red-400">{domainError}</p>
        ) : null}
        <div className="flex gap-2 mb-2">
          <input
            id={inputId}
            type="text"
            value={newUri}
            onChange={(e) => setNewUri(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void addRedirectUri())}
            placeholder="https://myapp.com/callback"
            disabled={readOnly}
            className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={() => void addRedirectUri()}
            disabled={readOnly || !newUri.trim() || redirectSaving}
            className="px-3 py-2 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 disabled:opacity-40 transition-colors"
          >
            {redirectSaving ? "Saving..." : "Add"}
          </button>
        </div>
        {redirectUris.length > 0 && (
          <div className="space-y-1">
            {redirectUris.map((uri) => (
              <div
                key={uri}
                className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/50 rounded-lg"
              >
                <code className="text-xs text-zinc-300 truncate">{uri}</code>
                <button
                  type="button"
                  onClick={() => void removeRedirectUri(uri)}
                  disabled={
                    readOnly ||
                    redirectSaving ||
                    (requireAtLeastOne && redirectUris.length <= 1)
                  }
                  className="text-zinc-500 hover:text-red-400 ml-2 shrink-0 disabled:opacity-40"
                  aria-label={`Remove ${uri}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showDomains ? (
        <div className="space-y-2">
          {domainError ? <p className="text-xs text-red-400">{domainError}</p> : null}
          <DomainAllowlistBlock
            appId={appId}
            domains={domains}
            onDomainsChange={onDomainsChange}
            readOnly={readOnly}
          />
        </div>
      ) : null}
    </div>
  );
}
