export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import DashboardLayout from "@/components/DashboardLayout";
import StreamSessionTable from "@/components/StreamSessionTable";
import TransactionLog from "@/components/TransactionLog";
import UserActions from "@/components/UserActions";
import { streamSessionToTableRow } from "@/platform/ops/stream-session-ui";
import { weiHumanWithUnit } from "@/shared/utils/format-wei";
import { getUserDetailPageData } from "@/platform/ops/runtime/end-users";

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getUserDetailPageData(id);
  if (!data) notFound();
  const { user, userStreams, userTxns, streamUsageCounts, totalUsage } = data;

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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/30">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
            Credit Balance
          </p>
          <p className="text-lg font-bold text-emerald-400">
            {weiHumanWithUnit(user.creditBalanceWei)}
          </p>
        </div>
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

      {/* Actions: issue token, add credits */}
      <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30 mb-8">
        <UserActions userId={id} />
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
