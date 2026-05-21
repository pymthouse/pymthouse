export const dynamic = "force-dynamic";

import DashboardLayout from "@/components/DashboardLayout";
import StreamSessionTable from "@/components/StreamSessionTable";
import {
  ACTIVE_STREAM_PAYMENT_WINDOW_LABEL,
  getStreamsPageData,
} from "@/platform/ops/runtime/streams";
import { streamSessionToTableRow } from "@/platform/ops/stream-session-ui";

export default async function StreamsPage() {
  const { activeSessions, historicalSessions, usageCounts } =
    await getStreamsPageData();

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight">Streams</h2>
        <p className="text-zinc-500 mt-1">
          Active streams are based on recent confirmed payments
        </p>
      </div>

      <div className="border border-zinc-800 rounded-xl bg-zinc-900/30 mb-8">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="font-semibold text-zinc-200">Active Streams</h3>
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-500/20 text-emerald-400">
            {activeSessions.length} {ACTIVE_STREAM_PAYMENT_WINDOW_LABEL}
          </span>
        </div>
        <StreamSessionTable
          sessions={activeSessions.map((s) =>
            streamSessionToTableRow(s, usageCounts),
          )}
        />
      </div>

      <div className="border border-zinc-800 rounded-xl bg-zinc-900/30">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="font-semibold text-zinc-200">Historical Sessions</h3>
        </div>
        <StreamSessionTable
          sessions={historicalSessions.map((s) =>
            streamSessionToTableRow(s, usageCounts),
          )}
        />
      </div>
    </DashboardLayout>
  );
}
