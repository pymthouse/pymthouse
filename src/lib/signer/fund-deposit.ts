import {
  fundDeposit,
  fundDepositAndReserve,
  getSenderInfo,
  type FundDepositResult,
  type SenderInfo,
} from "@/lib/signer-cli";

export type FundingDecision = {
  mode: "deposit" | "deposit_and_reserve";
  depositWei: bigint;
  reserveWei: bigint;
};

export type ExecuteFundingResult = FundingDecision &
  FundDepositResult;

const DEFAULT_RESERVE_FLOOR_WEI = 10_000_000_000_000_000n; // 0.01 ETH

export function getSignerReserveFloorWei(): bigint {
  const raw = process.env.SIGNER_RESERVE_FLOOR_WEI?.trim();
  if (!raw) return DEFAULT_RESERVE_FLOOR_WEI;
  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : DEFAULT_RESERVE_FLOOR_WEI;
  } catch {
    return DEFAULT_RESERVE_FLOOR_WEI;
  }
}

function parseBigIntField(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Decide how to split inbound ETH between TicketBroker deposit and reserve.
 * First funding always uses fundDepositAndReserve (broker requires reserve).
 */
export function decideFunding(
  senderInfo: SenderInfo | null,
  amountWei: bigint,
  reserveFloorWei: bigint = getSignerReserveFloorWei(),
): FundingDecision {
  if (amountWei <= 0n) {
    throw new Error("amountWei must be positive");
  }

  const deposit = parseBigIntField(senderInfo?.deposit);
  const reserveRemaining = parseBigIntField(senderInfo?.reserve?.fundsRemaining);
  const needsReserve =
    deposit === 0n || reserveRemaining < reserveFloorWei;

  if (!needsReserve) {
    return {
      mode: "deposit",
      depositWei: amountWei,
      reserveWei: 0n,
    };
  }

  const reserveTopUp =
    deposit === 0n
      ? reserveFloorWei
      : reserveFloorWei > reserveRemaining
        ? reserveFloorWei - reserveRemaining
        : 0n;

  let reserveWei = reserveTopUp > amountWei ? amountWei / 2n : reserveTopUp;
  if (reserveWei <= 0n) {
    reserveWei = amountWei / 10n;
  }
  if (reserveWei >= amountWei) {
    reserveWei = amountWei / 2n;
  }

  const depositWei = amountWei - reserveWei;
  return {
    mode: "deposit_and_reserve",
    depositWei,
    reserveWei,
  };
}

/**
 * Fund the shared signer TicketBroker deposit on-chain (source of truth).
 */
export async function executeFunding(
  amountWei: bigint,
  senderInfo?: SenderInfo | null,
): Promise<ExecuteFundingResult> {
  const info = senderInfo ?? (await getSenderInfo());
  const decision = decideFunding(info, amountWei);

  const result =
    decision.mode === "deposit"
      ? await fundDeposit(decision.depositWei)
      : await fundDepositAndReserve(decision.depositWei, decision.reserveWei);

  return {
    ...decision,
    ...result,
  };
}
