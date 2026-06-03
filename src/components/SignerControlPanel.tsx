"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSignerCliStatus } from "@/components/SignerCliStatusProvider";

export default function SignerControlPanel() {
  const router = useRouter();
  const { data, loading: cliLoading, refresh } = useSignerCliStatus();
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cliLive = data?.reachable === true;

  async function doAction(action: string) {
    setLoading(action);
    setMessage(null);
    setError(null);

    try {
      const res = await fetch("/api/v1/signer/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });

      const payload = await res.json();

      if (res.ok && payload.success) {
        setMessage(
          action === "sync"
            ? `Synced. Reachable: ${payload.reachable}${payload.ethAddress ? `, address: ${payload.ethAddress}` : ""}`
            : `${action} completed successfully`,
        );
        router.refresh();
        const delayMs = action === "sync" ? 0 : 2000;
        window.setTimeout(() => {
          void refresh();
        }, delayMs);
      } else {
        setError(payload.error || `${action} failed`);
      }
    } catch {
      setError(`Failed to ${action} signer`);
    } finally {
      setLoading(null);
    }
  }

  const showStartStop = data !== null && !cliLoading;

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-zinc-200">Control Plane</h3>

      <div className="flex flex-wrap gap-3">
        {showStartStop && !cliLive && (
          <button
            onClick={() => doAction("start")}
            disabled={!!loading}
            className="px-4 py-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-lg text-sm font-medium hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
          >
            {loading === "start" ? "Starting..." : "Start Signer"}
          </button>
        )}

        {showStartStop && cliLive && (
          <button
            onClick={() => doAction("stop")}
            disabled={!!loading}
            className="px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg text-sm font-medium hover:bg-red-500/20 transition-colors disabled:opacity-50"
          >
            {loading === "stop" ? "Stopping..." : "Stop Signer"}
          </button>
        )}

        {!showStartStop && (
          <span className="text-xs text-zinc-500 py-2">
            {cliLoading ? "Reading CLI status…" : "Waiting for CLI status…"}
          </span>
        )}

        <button
          onClick={() => doAction("restart")}
          disabled={!!loading}
          className="px-4 py-2 bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded-lg text-sm font-medium hover:bg-amber-500/20 transition-colors disabled:opacity-50"
        >
          {loading === "restart" ? "Restarting..." : "Restart"}
        </button>

        <button
          onClick={() => doAction("sync")}
          disabled={!!loading}
          className="px-4 py-2 bg-blue-500/10 text-blue-400 border border-blue-500/30 rounded-lg text-sm font-medium hover:bg-blue-500/20 transition-colors disabled:opacity-50"
        >
          {loading === "sync" ? "Syncing..." : "Sync Status"}
        </button>
      </div>

      {message && (
        <p className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
          {message}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
    </div>
  );
}
