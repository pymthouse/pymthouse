"use client";

interface TransactionRow {
  id: string;
  type: string;
  amountWei: string;
  platformCutPercent: number | null;
  platformCutWei: string | null;
  txHash: string | null;
  status: string;
  createdAt: string;
}

interface TransactionLogProps {
  transactions: TransactionRow[];
}

function formatWei(wei: string): string {
  if (wei === "0") return "0";
  const value = BigInt(wei);
  const eth = Number(value) / 1e18;
  if (eth < 0.0001) return `${wei} wei`;
  return `${eth.toFixed(6)} ETH`;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const typeBadge: Record<string, string> = {
  usage: "bg-blue-500/20 text-blue-400",
  prepay_credit: "bg-emerald-500/20 text-emerald-400",
  payout: "bg-amber-500/20 text-amber-400",
  refund: "bg-purple-500/20 text-purple-400",
};

const statusDot: Record<string, string> = {
  confirmed: "bg-emerald-400",
  pending: "bg-amber-400",
  failed: "bg-red-400",
};

export default function TransactionLog({
  transactions,
}: Readonly<TransactionLogProps>) {
  if (transactions.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <p>No transactions found</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
            <th className="text-left py-3 px-4 font-medium">Type</th>
            <th className="text-right py-3 px-4 font-medium">Amount</th>
            <th className="text-right py-3 px-4 font-medium">Platform Cut</th>
            <th className="text-center py-3 px-4 font-medium">Status</th>
            <th className="text-left py-3 px-4 font-medium">Tx Hash</th>
            <th className="text-right py-3 px-4 font-medium">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/50">
          {transactions.map((txn) => (
            <tr
              key={txn.id}
              className="hover:bg-zinc-900/50 transition-colors"
            >
              <td className="py-3 px-4">
                <span
                  className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                    typeBadge[txn.type] || typeBadge.usage
                  }`}
                >
                  {txn.type.replace("_", " ")}
                </span>
              </td>
              <td className="py-3 px-4 text-right text-zinc-300 font-mono text-xs">
                {formatWei(txn.amountWei)}
              </td>
              <td className="py-3 px-4 text-right text-zinc-400 text-xs">
                {txn.platformCutPercent != null && (
                  <span>
                    {txn.platformCutPercent}%
                    {txn.platformCutWei && (
                      <span className="text-zinc-500 ml-1">
                        ({formatWei(txn.platformCutWei)})
                      </span>
                    )}
                  </span>
                )}
              </td>
              <td className="py-3 px-4 text-center">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      statusDot[txn.status] || statusDot.pending
                    }`}
                  />
                  <span className="text-xs text-zinc-400">{txn.status}</span>
                </span>
              </td>
              <td className="py-3 px-4 font-mono text-zinc-500 text-xs">
                {txn.txHash
                  ? `${txn.txHash.slice(0, 8)}...${txn.txHash.slice(-4)}`
                  : "-"}
              </td>
              <td className="py-3 px-4 text-right text-zinc-500 text-xs">
                {timeAgo(txn.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
