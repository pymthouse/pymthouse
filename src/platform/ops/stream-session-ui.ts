import type { StreamSession } from "@/db/schema";

/** Shape expected by `StreamSessionTable` (client component). */
export function streamSessionToTableRow(
  s: StreamSession,
  usageCountBySessionId?: Map<string, number>,
) {
  const fromTx = usageCountBySessionId?.get(s.id);
  const signerPaymentCount =
    fromTx !== undefined
      ? Math.max(s.signerPaymentCount, fromTx)
      : s.signerPaymentCount;
  return {
    id: s.id,
    manifestId: s.manifestId,
    orchestratorAddress: s.orchestratorAddress,
    pricePerUnit: s.pricePerUnit,
    pixelsPerUnit: s.pixelsPerUnit,
    signerPaymentCount,
    totalFeeWei: s.totalFeeWei,
    status: s.status,
    startedAt: s.startedAt,
    lastPaymentAt: s.lastPaymentAt,
    endedAt: s.endedAt,
  };
}
