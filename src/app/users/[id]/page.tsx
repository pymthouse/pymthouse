export const dynamic = "force-dynamic";

import { db } from "@/db/index";
import { endUsers, streamSessions, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import DashboardLayout from "@/components/DashboardLayout";
import StreamSessionTable from "@/components/StreamSessionTable";
import TransactionLog from "@/components/TransactionLog";
import { streamSessionToTableRow } from "@/lib/stream-session-ui";
import { weiHumanWithUnit } from "@/lib/format-wei";
import { confirmedUsageCountByStreamSessionId } from "@/lib/stream-session-stats";

export default async function UserDetailPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;

  const userRows = await db
    .select()
    .from(endUsers)
    .where(eq(endUsers.id, id))
    .limit(1);
  const user = userRows[0];

  if (!user) notFound();

  const userStreams = await db
    .select()
    .from(streamSessions)
    .where(eq(streamSessions.endUserId, id));

  const streamUsageCounts = await confirmedUsageCountByStreamSessionId(
    userStreams.map((s) => s.id),
  );

  const userTxns = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      amountWei: transactions.amountWei,
      platformCutPercent: transactions.platformCutPercent,
      platformCutWei: transactions.platformCutWei,
      txHash: transactions.txHash,
      status: transactions.status,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(eq(transactions.endUserId, id));

  let totalUsage = 0n;
  for (const txn of userTxns) {
    if (txn.type === "usage") totalUsage += BigInt(txn.amountWei);
  }

  return (
    <DashboardLayout>
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-2xl font-bold tracking-tight">
            {user.name || user.email || "End User"}
          </h2>
          <span
            className={`px-2.5 py-0.5 text-xs font-medium rounded-full border ${
              user.isActive
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                : "bg-red-500/20 text-red-400 border-red-500/30"
            }`}
          >
            {user.isActive ? "active" : "suspended"}
          </span>
        </div>
        {user.email && (
          <p className="text-zinc-500 text-sm">{user.email}</p>
        )}
        {user.walletAddress && (
          <p className="text-zinc-500 font-mono text-sm mt-0.5">
            {user.walletAddress}
          </p>
        )}
      </div>

      {/* Stats */}
      {user.appId && user.externalUserId ? (
        <p className="text-sm text-zinc-500 mb-6">
          Allowance balance is managed in OpenMeter via Builder API ({" "}
          <code className="text-zinc-400">GET .../usage/balance</code>
          {" "}) for app{" "}
          <span className="font-mono text-zinc-400">{user.appId}</span> / user{" "}
          <span className="font-mono text-zinc-400">{user.externalUserId}</span>.
        </p>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <div className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/30">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
            Total Usage
          </p>
          <p className="text-lg font-bold text-amber-400">
            {weiHumanWithUnit(totalUsage.toString())}
          </p>
        </div>
        <div className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/30">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
            Streams
          </p>
          <p className="text-lg font-bold text-blue-400">
            {userStreams.length}
          </p>
        </div>
      </div>

      {/* Stream sessions */}
      <div className="border border-zinc-800 rounded-xl bg-zinc-900/30 mb-8">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="font-semibold text-zinc-200">Stream Sessions</h3>
        </div>
        <StreamSessionTable
          sessions={userStreams.map((s) =>
            streamSessionToTableRow(s, streamUsageCounts),
          )}
        />
      </div>

      {/* Transactions */}
      <div className="border border-zinc-800 rounded-xl bg-zinc-900/30">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="font-semibold text-zinc-200">Transactions</h3>
        </div>
        <TransactionLog transactions={userTxns.slice(0, 50)} />
      </div>
    </DashboardLayout>
  );
}
