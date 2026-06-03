"use client";

import { useEffect, useState } from "react";
import { useSignerCliStatus } from "@/components/SignerCliStatusProvider";
import type { SignerCliSenderInfo } from "@/components/SignerCliStatusProvider";

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

function formatLpt(wei: string | null | undefined): string {
  if (!wei || wei === "0") return "0 LPT";
  try {
    const value = BigInt(wei);
    const lpt = Number(value) / 1e18;
    return `${lpt.toFixed(4)} LPT`;
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
    <div className={`border border-zinc-800 rounded-xl p-4 bg-zinc-900/30 ${dim ? "opacity-50" : ""}`}>
      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className={`text-sm font-medium font-mono ${color}`}>{value}</p>
    </div>
  );
}

export default function SignerLiveStats() {
  const { data, loading, refresh } = useSignerCliStatus();
  const [, setTick] = useState(0); // force re-render for time display

  useEffect(() => {
    const tick = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(tick);
  }, []);

  const si: SignerCliSenderInfo | null | undefined = data?.senderInfo;
  const unreachable = data !== null && !data.reachable;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold text-zinc-200">Live Signer State</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            From <code className="text-zinc-400">SIGNER_CLI_URL</code> (DMZ: Apache
            proxies <code className="text-zinc-400">/__signer_cli</code> to livepeer
            CLI). Same data as livepeer_cli.
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
              CLI unreachable
            </span>
          )}
          {data?.reachable && (
            <span className="text-xs text-emerald-500 border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 rounded-full">
              live
            </span>
          )}
          <button
            onClick={() => void refresh()}
            className="px-2.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <p className="text-xs text-zinc-500 animate-pulse">
          Connecting to signer CLI (SIGNER_CLI_URL)…
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="Deposit"
            value={si ? formatWei(si.deposit) : "—"}
            dim={unreachable}
          />
          <StatCard
            label="Reserve"
            value={si ? formatWei(si.reserve.fundsRemaining) : "—"}
            dim={unreachable}
          />
          <StatCard
            label="ETH Balance"
            value={data?.ethBalance ? formatWei(data.ethBalance) : "—"}
            dim={unreachable}
          />
          <StatCard
            label="LPT Balance"
            value={data?.tokenBalance ? formatLpt(data.tokenBalance) : "—"}
            dim={unreachable}
          />
          {si && si.withdrawRound !== "0" && (
            <StatCard
              label="Withdraw Round"
              value={si.withdrawRound}
              color="text-amber-400"
            />
          )}
          {si && (
            <StatCard
              label="Claimed This Round"
              value={formatWei(si.reserve.claimedInCurrentRound)}
              color="text-zinc-400"
            />
          )}
        </div>
      )}
    </div>
  );
}
