"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Props = {
  appId: string;
  externalUserId: string;
  status: string;
  canManage: boolean;
};

/**
 * Soft-deactivate / reactivate an M2M identity via Builder users API.
 * Deactivate frees an end-user cap slot; reactivate consumes one.
 */
export default function IdentityLifecycleActions({
  appId,
  externalUserId,
  status,
  canManage,
}: Readonly<Props>) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStatus, setCurrentStatus] = useState(status);

  if (!canManage || (currentStatus !== "active" && currentStatus !== "inactive")) {
    return null;
  }

  const isActive = currentStatus === "active";

  async function deactivate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/apps/${encodeURIComponent(appId)}/users?externalUserId=${encodeURIComponent(externalUserId)}`,
        { method: "DELETE" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        title?: string;
        detail?: string;
      };
      if (!res.ok) {
        throw new Error(body.detail || body.title || body.error || `HTTP ${res.status}`);
      }
      setCurrentStatus("inactive");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deactivate");
    } finally {
      setBusy(false);
    }
  }

  async function reactivate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/apps/${encodeURIComponent(appId)}/users`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalUserId,
          status: "active",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        title?: string;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        throw new Error(
          body.detail || body.title || body.error || `HTTP ${res.status}`,
        );
      }
      setCurrentStatus("active");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reactivate");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-4">
      <h2 className="text-sm font-semibold text-zinc-200">Account lifecycle</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Soft-deactivate frees an end-user slot on the activation cap. Reactivating
        consumes a free slot. Tokens and API keys stop working while inactive.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isActive ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void deactivate()}
            className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Deactivating…" : "Deactivate identity"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void reactivate()}
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Reactivating…" : "Reactivate identity"}
          </button>
        )}
        <span className="text-xs uppercase tracking-wider text-zinc-500">
          {currentStatus}
        </span>
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </div>
  );
}
