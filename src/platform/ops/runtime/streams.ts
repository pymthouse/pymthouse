import {
  ACTIVE_STREAM_PAYMENT_WINDOW_LABEL,
  getActiveStreamSessionsByRecentPayment,
} from "../active-streams";
import { confirmedUsageCountByStreamSessionId } from "../stream-session-stats";
import { listAllStreamSessions } from "../repo/streams";

export { ACTIVE_STREAM_PAYMENT_WINDOW_LABEL };

function sessionRecencyMs(s: { lastPaymentAt: string | null; startedAt: string }) {
  const t = s.lastPaymentAt ?? s.startedAt;
  return new Date(t).getTime();
}

export async function getStreamsPageData() {
  const activeSessions = await getActiveStreamSessionsByRecentPayment();
  const activeSessionIds = new Set(activeSessions.map((session) => session.id));

  const allSessions = await listAllStreamSessions();
  const historicalSessions = allSessions
    .filter((s) => !activeSessionIds.has(s.id))
    .sort((a, b) => sessionRecencyMs(b) - sessionRecencyMs(a))
    .slice(0, 100);

  const usageCounts = await confirmedUsageCountByStreamSessionId([
    ...activeSessions.map((s) => s.id),
    ...historicalSessions.map((s) => s.id),
  ]);

  return {
    activeSessions,
    historicalSessions,
    usageCounts,
  };
}
