"use client";

import { useState } from "react";

interface Props {
  appId: string | null;
  redirectUris: string[];
  onRedirectUrisChange: (uris: string[]) => void;
  domains: { id: string; domain: string }[];
  onDomainsChange: (domains: { id: string; domain: string }[]) => void;
  readOnly?: boolean;
}

async function parseDomainError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = text ? JSON.parse(text) : {};
    if (typeof data.error === "string" && data.error.trim()) {
      return data.error.trim();
    }
  } catch {
    /* keep fallback */
  }
  return text.trim() || res.statusText || `Domain request failed (${res.status})`;
}

export default function AuthorizationCodeRedirectBlock({
  appId,
  redirectUris,
  onRedirectUrisChange,
  domains,
  onDomainsChange,
  readOnly = false,
}: Readonly<Props>) {
  const [newUri, setNewUri] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [redirectPersistError, setRedirectPersistError] = useState<string | null>(null);
  const [redirectSaving, setRedirectSaving] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);

  const persistRedirectUris = async (nextUris: string[]) => {
    if (readOnly) return false;
    if (!appId) return true;
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
    }

    if (appId) {
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
    }
  };

  const removeRedirectUri = async (uri: string) => {
    if (readOnly) return;
    const previous = redirectUris;
    const next = redirectUris.filter((u) => u !== uri);
    onRedirectUrisChange(next);
    if (appId) {
      const ok = await persistRedirectUris(next);
      if (!ok) onRedirectUrisChange(previous);
    }
  };

  const addDomain = async () => {
    if (readOnly || !appId || !newDomain.trim()) return;
    setAdding(true);
    setDomainError(null);
    try {
      const res = await fetch(`/api/v1/apps/${appId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim() }),
      });
      if (!res.ok) {
        setDomainError(await parseDomainError(res));
        return;
      }
      const resData = await res.json();
      onDomainsChange([...domains, { id: resData.id, domain: resData.domain }]);
      setNewDomain("");
    } catch (err) {
      setDomainError(err instanceof Error ? err.message : "Could not add domain.");
    } finally {
      setAdding(false);
    }
  };

  const removeDomain = async (domainId: string) => {
    if (readOnly || !appId) return;
    setDomainError(null);
    try {
      const res = await fetch(
        `/api/v1/apps/${appId}/domains?domainId=${encodeURIComponent(domainId)}`,
        {
          method: "DELETE",
        },
      );
      if (!res.ok) {
        setDomainError(await parseDomainError(res));
        return;
      }
      onDomainsChange(domains.filter((d) => d.id !== domainId));
    } catch (err) {
      setDomainError(err instanceof Error ? err.message : "Could not remove domain.");
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="auth-code-new-redirect-uri" className="block text-sm font-medium text-zinc-300">
          Redirect URIs
        </label>
        <p className="text-xs text-zinc-500">
          URIs where PymtHouse can redirect after authorization. Wildcards (*) are supported.
          {appId
            ? " Each add or remove is saved immediately."
            : " Save the app first, then add URIs here."}
        </p>
        {redirectPersistError && (
          <p className="text-xs text-red-400">{redirectPersistError}</p>
        )}
        <div className="flex gap-2 mb-2">
          <input
            id="auth-code-new-redirect-uri"
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
                  disabled={readOnly || redirectSaving}
                  className="text-zinc-500 hover:text-red-400 ml-2 shrink-0 disabled:opacity-40"
                  aria-label={`Remove ${uri}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-zinc-300">Domain allowlist</h4>
          <p className="text-xs text-zinc-500 mt-1">
            Allowed origins for CORS and request validation. Redirect URIs above should match these
            domains.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void addDomain())}
            placeholder="example.com"
            disabled={readOnly}
            className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={() => void addDomain()}
            disabled={readOnly || adding || !newDomain.trim() || !appId}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-500 disabled:opacity-40 transition-colors"
          >
            {adding ? "Adding..." : "Add domain"}
          </button>
        </div>
        {domainError && <p className="text-xs text-red-400">{domainError}</p>}
        {domains.length > 0 ? (
          <div className="space-y-2">
            {domains.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between px-4 py-3 bg-zinc-800/50 rounded-lg border border-zinc-800"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <code className="text-sm text-zinc-200 truncate">{d.domain}</code>
                </div>
                <button
                  type="button"
                  onClick={() => void removeDomain(d.id)}
                  disabled={readOnly}
                  className="text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  aria-label={`Remove domain ${d.domain}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-3 text-zinc-500 text-sm">
            No domains yet. Add your app&apos;s origins above (adding a redirect URI may suggest
            one automatically).
          </div>
        )}
      </div>
    </div>
  );
}
