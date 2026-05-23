"use client";

import { useEffect, useState } from "react";

interface PaymentStatus {
  reachable: boolean;
  socketPath: string;
  socketExists: boolean;
  healthStatus: string | null;
  ethAddress: string | null;
  deposit: string | null;
  reserve: string | null;
  withdrawRound: string | null;
  containerRunning: boolean;
  senderContainerRunning: boolean;
  registryContainerRunning: boolean;
  fetchedAt: string;
  error: string | null;
}

function formatWei(wei: string | null | undefined): string {
  if (!wei || wei === "0") return "0";
  try {
    const value = BigInt(wei);
    const eth = Number(value) / 1e18;
    if (eth < 0.001) return `${wei} WEI`;
    return `${eth.toFixed(6)} ETH`;
  } catch {
    return wei;
  }
}

function timeAgo(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

function StatCard({
  label,
  value,
  color = "text-zinc-200",
  dim = false,
}: {
  label: string;
  value: string;
  color?: string;
  dim?: boolean;
}) {
  return (
    <div
      className={`border border-zinc-800 rounded-xl p-4 bg-zinc-900/30 ${dim ? "opacity-50" : ""}`}
    >
      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className={`text-sm font-medium font-mono ${color}`}>{value}</p>
    </div>
  );
}

export default function PaymentLiveStats() {
  const [data, setData] = useState<PaymentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);

  async function fetchStats() {
    try {
      const res = await fetch("/api/v1/payment/status");
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // keep last known state
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStats();
    const poll = setInterval(fetchStats, 15000);
    const tick = setInterval(() => setTick((t) => t + 1), 5000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const unreachable = data !== null && !data.reachable;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold text-zinc-200">Live Payment Daemon State</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            From <code className="text-zinc-400">PayerDaemon</code> gRPC over the
            unix socket (<code className="text-zinc-400">Health</code>,{" "}
            <code className="text-zinc-400">Identify</code>,{" "}
            <code className="text-zinc-400">GetDepositInfo</code>).
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-xs text-zinc-600">
              Updated {timeAgo(data.fetchedAt)}
            </span>
          )}
          {unreachable && (
            <span className="text-xs text-amber-500 border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 rounded-full">
              socket unreachable
            </span>
          )}
          {data?.reachable && (
            <span className="text-xs text-emerald-500 border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 rounded-full">
              live
            </span>
          )}
          <button
            onClick={fetchStats}
            className="px-2.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {data?.error && (
        <div className="mb-4 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs">
          {data.error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-zinc-500 animate-pulse">
          Connecting to PayerDaemon unix socket…
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="Payer Address"
            value={data?.ethAddress || "—"}
            dim={unreachable}
          />
          <StatCard
            label="Deposit"
            value={data?.deposit ? formatWei(data.deposit) : "—"}
            dim={unreachable}
          />
          <StatCard
            label="Reserve"
            value={data?.reserve ? formatWei(data.reserve) : "—"}
            dim={unreachable}
          />
          <StatCard
            label="Health"
            value={data?.healthStatus || "—"}
            color={data?.reachable ? "text-emerald-400" : "text-zinc-400"}
            dim={unreachable}
          />
          {data?.withdrawRound && data.withdrawRound !== "0" && (
            <StatCard
              label="Withdraw Round"
              value={data.withdrawRound}
              color="text-amber-400"
            />
          )}
          <StatCard
            label="Sender Container"
            value={data?.senderContainerRunning ? "running" : "stopped"}
            color={
              data?.senderContainerRunning ? "text-emerald-400" : "text-zinc-400"
            }
          />
          <StatCard
            label="Registry Container"
            value={data?.registryContainerRunning ? "running" : "stopped"}
            color={
              data?.registryContainerRunning
                ? "text-emerald-400"
                : "text-zinc-400"
            }
          />
          <StatCard
            label="Socket"
            value={data?.socketExists ? "present" : "missing"}
            color={data?.socketExists ? "text-emerald-400" : "text-red-400"}
          />
        </div>
      )}
    </div>
  );
}
