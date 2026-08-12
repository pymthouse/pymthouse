import { createHash } from "node:crypto";

export function buildGrantIdempotencyKey(input: {
  adminId: string;
  ownerUserId: string;
  amountUsdMicros: string;
  source: string;
  note: string;
  nowMs?: number;
}): string {
  const bucket = Math.floor((input.nowMs ?? Date.now()) / 60_000);
  const noteHash = createHash("sha256")
    .update(input.note)
    .digest("hex")
    .slice(0, 16);
  return [
    "admin-credit-grant",
    input.adminId,
    input.ownerUserId,
    input.amountUsdMicros,
    input.source,
    noteHash,
    String(bucket),
  ].join(":");
}
