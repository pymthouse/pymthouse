import { confirmedUsageCountByStreamSessionId } from "../stream-session-stats";
import {
  countEndUserTransactions,
  getEndUserById,
  listAdminUsers,
  listEndUserSessions,
  listEndUserStreams,
  listEndUserTransactions,
  listEndUsers,
} from "../repo/end-users";

export async function getUsersPageData() {
  const [adminUsers, allEndUsers] = await Promise.all([
    listAdminUsers(),
    listEndUsers(),
  ]);

  const enriched = await Promise.all(
    allEndUsers.map(async (user) => {
      const [userSessionRows, userStreams, transactionCount] = await Promise.all([
        listEndUserSessions(user.id),
        listEndUserStreams(user.id),
        countEndUserTransactions(user.id),
      ]);

      return {
        ...user,
        tokenCount: userSessionRows.length,
        streamCount: userStreams.length,
        transactionCount,
      };
    }),
  );

  return {
    adminUsers,
    enrichedEndUsers: enriched,
  };
}

export async function getUserDetailPageData(id: string) {
  const user = await getEndUserById(id);
  if (!user) {
    return null;
  }

  const [userStreams, userTxns] = await Promise.all([
    listEndUserStreams(id),
    listEndUserTransactions(id),
  ]);

  const streamUsageCounts = await confirmedUsageCountByStreamSessionId(
    userStreams.map((s) => s.id),
  );

  let totalUsage = 0n;
  for (const txn of userTxns) {
    if (txn.type === "usage") totalUsage += BigInt(txn.amountWei);
  }

  return {
    user,
    userStreams,
    userTxns,
    streamUsageCounts,
    totalUsage,
  };
}
