import {
  ACTIVE_STREAM_PAYMENT_WINDOW_LABEL,
  countActiveStreamsByRecentPayment,
  getActiveStreamSessionsByRecentPayment,
} from "../active-streams";
import {
  getDefaultSignerSnapshot,
  listEndUsers,
  listTransactionFeeRows,
} from "../repo/dashboard";

export { ACTIVE_STREAM_PAYMENT_WINDOW_LABEL };

export function formatDashboardWei(wei: string): string {
  if (wei === "0") return "0 ETH";
  const value = BigInt(wei);
  const eth = Number(value) / 1e18;
  if (eth < 0.001) return `${wei} wei`;
  return `${eth.toFixed(6)} ETH`;
}

export async function getAdminDashboardData() {
  const [signer, activeStreamCount, recentActiveSessions, allTransactions, allEndUsers] =
    await Promise.all([
      getDefaultSignerSnapshot(),
      countActiveStreamsByRecentPayment(),
      getActiveStreamSessionsByRecentPayment(5),
      listTransactionFeeRows(),
      listEndUsers(),
    ]);

  let totalFeeWei = 0n;
  let totalPlatformCutWei = 0n;
  for (const txn of allTransactions) {
    totalFeeWei += BigInt(txn.amountWei);
    totalPlatformCutWei += BigInt(txn.platformCutWei || "0");
  }

  return {
    signer,
    activeStreamCount,
    recentActiveSessions,
    allTransactions,
    allEndUsers,
    totalFeeWei,
    totalPlatformCutWei,
  };
}
