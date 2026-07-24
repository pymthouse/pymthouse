"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface SignerControlPanelProps {
  currentStatus: string;
  managedRemote?: boolean;
}

export default function SignerControlPanel({
  currentStatus,
  managedRemote = false,
}: Readonly<SignerControlPanelProps>) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      const data = await res.json();

      if (res.ok && data.success) {
        setMessage(
          action === "sync"
            ? `Synced. Reachable: ${data.reachable}${data.ethAddress ? `, address: ${data.ethAddress}` : ""}`
            : `${action} completed successfully`
        );
        router.refresh();
      } else {
        setError(data.error || `${action} failed`);
      }
    } catch {
      setError(`Failed to ${action} signer`);
    } finally {
      setLoading(null);
    }
  }

  const isRunning = currentStatus === "running";

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-zinc-200">Control Plane</h3>

      {managedRemote && (
        <p className="text-xs text-zinc-500">
          Start, stop, and restart use local Docker and are unavailable on Vercel.
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        {!managedRemote && !isRunning && (
          <button
            type="button"
            onClick={() => doAction("start")}
            disabled={!!loading}
            className="px-4 py-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-lg text-sm font-medium hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
          >
            {loading === "start" ? "Starting..." : "Start Signer"}
          </button>
        )}

        {!managedRemote && isRunning && (
          <button
            type="button"
            onClick={() => doAction("stop")}
            disabled={!!loading}
            className="px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg text-sm font-medium hover:bg-red-500/20 transition-colors disabled:opacity-50"
          >
            {loading === "stop" ? "Stopping..." : "Stop Signer"}
          </button>
        )}

        {!managedRemote && (
          <button
            type="button"
            onClick={() => doAction("restart")}
            disabled={!!loading}
            className="px-4 py-2 bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded-lg text-sm font-medium hover:bg-amber-500/20 transition-colors disabled:opacity-50"
          >
            {loading === "restart" ? "Restarting..." : "Restart"}
          </button>
        )}

        <button
          type="button"
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
