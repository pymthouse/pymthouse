"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ApiKeyCredentialSwitcher from "@/components/apps/ApiKeyCredentialSwitcher";
import CopyIdButton from "@/components/apps/CopyIdButton";
import AppFilterDropdown from "@/components/AppFilterDropdown";
import { useNetworkKeyMint } from "@/hooks/useNetworkKeyMint";
import { PLATFORM_DEFAULT_USAGE_DISPLAY_NAME } from "@/lib/platform-default-labels";

type ApiKeyRow = {
  id: string;
  label: string | null;
  prefix: string;
  suffix: string;
  status: string;
  createdAt: string;
  revokedAt: string | null;
  clientId: string;
  appName: string;
  isPlatformDefault: boolean;
};

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function maskedKey(prefix: string, suffix: string): string {
  return `${prefix}…${suffix}`;
}

function sourceLabel(key: ApiKeyRow): string {
  return key.isPlatformDefault
    ? PLATFORM_DEFAULT_USAGE_DISPLAY_NAME
    : key.appName;
}

function activeKeyCountLabel(count: number): string {
  return count === 1 ? "1 active key" : `${count} active keys`;
}

function KeysSkeleton() {
  return (
    <div className="divide-y divide-zinc-800/60 animate-pulse">
      {["a", "b", "c"].map((k) => (
        <div key={k} className="flex items-center gap-4 px-5 py-4">
          <div className="h-3 w-40 rounded bg-zinc-800" />
          <div className="h-3 w-24 rounded bg-zinc-800/70" />
        </div>
      ))}
    </div>
  );
}

function NoKeysState() {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm text-zinc-400">No API keys yet.</p>
      <p className="mt-1 text-xs text-zinc-500">
        Create a personal key to call the Livepeer network, or mint one from an
        app you own.
      </p>
    </div>
  );
}

function NoFilterMatchState({ onShowAll }: Readonly<{ onShowAll: () => void }>) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm text-zinc-400">No keys match this filter.</p>
      <button
        type="button"
        onClick={onShowAll}
        className="mt-3 text-xs font-medium text-emerald-400 hover:text-emerald-300"
      >
        Show all sources
      </button>
    </div>
  );
}

/**
 * Self-service API key list: create personal keys, view metadata, revoke.
 */
export default function ApiKeysManager() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [selectedSources, setSelectedSources] = useState<string[] | null>(null);
  const { mint, mintKey, resetMint } = useNetworkKeyMint();

  const sourceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const key of keys) {
      if (!seen.has(key.clientId)) {
        seen.set(key.clientId, sourceLabel(key));
      }
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => {
        if (a.label === PLATFORM_DEFAULT_USAGE_DISPLAY_NAME) return -1;
        if (b.label === PLATFORM_DEFAULT_USAGE_DISPLAY_NAME) return 1;
        return a.label.localeCompare(b.label);
      });
  }, [keys]);

  // Default to all sources selected once options are known.
  const activeSources = selectedSources ?? sourceOptions.map((o) => o.value);

  const filteredKeys = useMemo(() => {
    if (activeSources.length === sourceOptions.length) return keys;
    const allowed = new Set(activeSources);
    return keys.filter((k) => allowed.has(k.clientId));
  }, [keys, activeSources, sourceOptions.length]);

  const filteredActiveCount = useMemo(
    () => filteredKeys.filter((k) => k.status === "active").length,
    [filteredKeys],
  );

  const loadKeys = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/v1/me/keys", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const message = [
          data.error_description,
          data.error,
          `Request failed (${res.status})`,
        ].find((v): v is string => typeof v === "string" && v.trim().length > 0);
        throw new Error(message ?? "Failed to load keys.");
      }
      setKeys(Array.isArray(data.keys) ? (data.keys as ApiKeyRow[]) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  // After a successful mint, refresh the list so the new key appears.
  useEffect(() => {
    if (mint.phase === "success") {
      void loadKeys();
    }
  }, [mint.phase, loadKeys]);

  async function handleRevoke(keyId: string) {
    setRevokingId(keyId);
    setError(null);
    try {
      const res = await fetch(`/api/v1/me/keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const message = [
          data.error_description,
          data.error,
          `Request failed (${res.status})`,
        ].find((v): v is string => typeof v === "string" && v.trim().length > 0);
        throw new Error(message ?? "Failed to revoke key.");
      }
      setConfirmId(null);
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key.");
    } finally {
      setRevokingId(null);
    }
  }

  function renderKeysBody() {
    if (loading) return <KeysSkeleton />;
    if (keys.length === 0) return <NoKeysState />;
    if (filteredKeys.length === 0) {
      return (
        <NoFilterMatchState
          onShowAll={() => setSelectedSources(sourceOptions.map((o) => o.value))}
        />
      );
    }
    return (
      <ul className="divide-y divide-zinc-800/60">
        {filteredKeys.map((row) => (
          <KeyRow
            key={row.id}
            keyRow={row}
            confirming={confirmId === row.id}
            revoking={revokingId === row.id}
            onRequestConfirm={() => setConfirmId(row.id)}
            onCancelConfirm={() => setConfirmId(null)}
            onRevoke={() => void handleRevoke(row.id)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">API Keys</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Keys you&apos;ve minted for personal network access and as an app
            owner. Secrets are shown once at creation — revoke any key you no
            longer need.
          </p>
        </div>
        <button
          type="button"
          disabled={mint.phase === "minting"}
          onClick={() => void mintKey()}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-emerald-600/50 px-3 text-sm font-medium text-emerald-400 transition-colors hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {mint.phase === "minting" ? (
            <span
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-600/40 border-t-emerald-400"
              aria-hidden
            />
          ) : (
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.75}
                d="M12 4v16m8-8H4"
              />
            </svg>
          )}
          {mint.phase === "minting" ? "Creating…" : "New personal key"}
        </button>
      </div>

      {mint.phase === "error" && (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm font-medium text-red-300">Failed to create key</p>
          <p className="mt-1 text-xs text-red-200/80">{mint.message}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void mintKey()}
              className="rounded-md border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={resetMint}
              className="rounded-md border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {mint.phase === "success" && (
        <output className="block space-y-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-sky-200">New personal key</p>
              <p className="mt-0.5 text-[11px] text-amber-300">
                Store this securely — it will not be shown again.
              </p>
            </div>
            <button
              type="button"
              onClick={resetMint}
              className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-100 hover:bg-sky-500/20"
            >
              Done
            </button>
          </div>
          <ApiKeyCredentialSwitcher
            apiKey={mint.apiKey}
            sdkToken={mint.sdkToken}
            defaultFormat="bearer"
          />
          {mint.clientId ? (
            <div className="rounded-md border border-sky-500/15 bg-black/20 px-2.5 py-2">
              <p className="text-[10px] font-mono uppercase tracking-wider text-sky-300/60">
                clientId (for REST paths)
              </p>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-sky-100">
                  {mint.clientId}
                </code>
                <CopyIdButton value={mint.clientId} label="Copy client ID" />
              </div>
              <p className="mt-1.5 text-[10px] text-sky-300/55">
                Usage:{" "}
                <code className="font-mono text-sky-200/80">
                  GET /api/v1/apps/{mint.clientId}/me/usage
                </code>
              </p>
            </div>
          ) : null}
        </output>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02]">
        <div className="flex flex-col gap-3 border-b border-white/[0.06] px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-zinc-500">
            {loading ? "Loading…" : activeKeyCountLabel(filteredActiveCount)}
            {!loading && filteredKeys.length > filteredActiveCount
              ? ` · ${filteredKeys.length - filteredActiveCount} revoked`
              : null}
          </p>
          {!loading && sourceOptions.length > 0 && (
            <AppFilterDropdown
              options={sourceOptions}
              selectedValues={activeSources}
              onChange={setSelectedSources}
              label="Source"
              emptyLabel="No sources"
              allLabel="All sources"
            />
          )}
        </div>

        {renderKeysBody()}
      </section>
    </div>
  );
}

function KeyRow({
  keyRow,
  confirming,
  revoking,
  onRequestConfirm,
  onCancelConfirm,
  onRevoke,
}: Readonly<{
  keyRow: ApiKeyRow;
  confirming: boolean;
  revoking: boolean;
  onRequestConfirm: () => void;
  onCancelConfirm: () => void;
  onRevoke: () => void;
}>) {
  const isActive = keyRow.status === "active";

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm text-zinc-200">
              {maskedKey(keyRow.prefix, keyRow.suffix)}
            </code>
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                isActive
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-zinc-700/60 text-zinc-400"
              }`}
            >
              {isActive ? "Active" : "Revoked"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span>{sourceLabel(keyRow)}</span>
            {keyRow.label && <span className="text-zinc-600">·</span>}
            {keyRow.label && <span>{keyRow.label}</span>}
            <span className="text-zinc-600">·</span>
            <span title={keyRow.createdAt}>
              Created {formatCreatedAt(keyRow.createdAt)}
            </span>
            {keyRow.revokedAt && (
              <>
                <span className="text-zinc-600">·</span>
                <span title={keyRow.revokedAt}>
                  Revoked {formatCreatedAt(keyRow.revokedAt)}
                </span>
              </>
            )}
          </div>
        </div>

        {isActive && (
          <div className="flex shrink-0 items-center gap-2">
            {confirming ? (
              <>
                <span className="text-xs text-zinc-400">Revoke this key?</span>
                <button
                  type="button"
                  disabled={revoking}
                  onClick={onRevoke}
                  className="rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:opacity-60"
                >
                  {revoking ? "Revoking…" : "Confirm"}
                </button>
                <button
                  type="button"
                  disabled={revoking}
                  onClick={onCancelConfirm}
                  className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onRequestConfirm}
                className="rounded-lg border border-zinc-700/80 px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-red-500/40 hover:text-red-300"
              >
                Revoke
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
