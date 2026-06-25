import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { signerDepositEvents } from "@/db/schema";
import { computeUsdMicrosFromWei } from "@/lib/billing-runtime";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { getEthUsdOracle } from "@/lib/prices/eth-usd-oracle";
import { executeFunding } from "@/lib/signer/fund-deposit";
import { swapUsdcToEth } from "@/lib/signer/swap-usdc-to-eth";
import type { ResolvedDepositPayer } from "@/lib/turnkey/resolve-deposit-payer";

export type IngressAsset = "eth" | "usdc";

export type ClearDepositInput = {
  eventId: string;
  idempotencyKey: string;
  txHash: string | null;
  fromAddress: string;
  payer: ResolvedDepositPayer;
  ingressAsset: IngressAsset;
  /** Raw amount: wei for ETH, 6-decimal USDC units for USDC. */
  amountRaw: string;
};

export type ClearDepositResult = {
  status: "credited";
  fundTxHash: string;
  usdMicrosCredited: string;
  ethWeiRealized: string;
  swapTxHash?: string | null;
};

/**
 * Fund TicketBroker on-chain, then credit OpenMeter (fund-first ordering).
 */
export async function clearAttributedDeposit(
  input: ClearDepositInput,
): Promise<ClearDepositResult> {
  let ethWeiRealized: bigint;
  let swapTxHash: string | null = null;

  if (input.ingressAsset === "usdc") {
    const usdcRaw = BigInt(input.amountRaw);
    const swap = await swapUsdcToEth(usdcRaw);
    ethWeiRealized = swap.ethWeiOut;
    swapTxHash = swap.txHash;
  } else {
    ethWeiRealized = BigInt(input.amountRaw);
  }

  if (ethWeiRealized <= 0n) {
    throw new Error("non_positive_eth_after_ingress");
  }

  const oracle = await getEthUsdOracle();
  const usdMicros = computeUsdMicrosFromWei(ethWeiRealized, oracle.priceUsd);
  if (usdMicros <= 0n) {
    throw new Error("zero_usd_micros");
  }

  await db.insert(signerDepositEvents).values({
    id: input.eventId,
    idempotencyKey: input.idempotencyKey,
    txHash: input.txHash,
    fromAddress: input.fromAddress,
    amountWei: input.amountRaw,
    ethUsdPrice: String(oracle.priceUsd),
    appId: input.payer.appId,
    externalUserId: input.payer.externalUserId,
    ingressAsset: input.ingressAsset,
    status: "pending",
  });

  let funding;
  try {
    funding = await executeFunding(ethWeiRealized);
  } catch (err) {
    await db
      .update(signerDepositEvents)
      .set({
        status: "error",
        errorMessage: err instanceof Error ? err.message : "fund_deposit_failed",
      })
      .where(eq(signerDepositEvents.id, input.eventId));
    throw err;
  }

  await db
    .update(signerDepositEvents)
    .set({
      status: "funded",
      fundTxHash: funding.txHash,
      depositWeiFunded: funding.depositWei.toString(),
      reserveWeiFunded: funding.reserveWei.toString(),
      swapTxHash,
      ethWeiRealized: ethWeiRealized.toString(),
    })
    .where(eq(signerDepositEvents.id, input.eventId));

  try {
    await grantAllowanceUsdMicros({
      clientId: input.payer.appId,
      externalUserId: input.payer.externalUserId,
      amountUsdMicros: usdMicros,
      source: "onchain_deposit",
    });
  } catch (err) {
    console.error("grantAllowanceUsdMicros failed after fundDeposit:", err);
    throw err;
  }

  await db
    .update(signerDepositEvents)
    .set({
      status: "credited",
      usdMicrosCredited: usdMicros.toString(),
    })
    .where(eq(signerDepositEvents.id, input.eventId));

  return {
    status: "credited",
    fundTxHash: funding.txHash,
    usdMicrosCredited: usdMicros.toString(),
    ethWeiRealized: ethWeiRealized.toString(),
    swapTxHash,
  };
}

/**
 * Retry OpenMeter credit for a row already in `funded` status.
 */
export async function retryDepositCredit(eventId: string): Promise<ClearDepositResult> {
  const rows = await db
    .select()
    .from(signerDepositEvents)
    .where(eq(signerDepositEvents.id, eventId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new Error("deposit_event_not_found");
  }
  if (row.status === "credited") {
    return {
      status: "credited",
      fundTxHash: row.fundTxHash ?? "",
      usdMicrosCredited: row.usdMicrosCredited ?? "0",
      ethWeiRealized: row.ethWeiRealized ?? row.amountWei,
      swapTxHash: row.swapTxHash,
    };
  }
  if (row.status !== "funded") {
    throw new Error(`cannot_retry_credit_from_status_${row.status}`);
  }
  if (!row.appId || !row.externalUserId || !row.fundTxHash) {
    throw new Error("funded_row_missing_fields");
  }

  const ethWeiRealized = BigInt(row.ethWeiRealized ?? row.amountWei);
  const oraclePrice = row.ethUsdPrice ? Number(row.ethUsdPrice) : (await getEthUsdOracle()).priceUsd;
  const usdMicros = computeUsdMicrosFromWei(ethWeiRealized, oraclePrice);
  if (usdMicros <= 0n) {
    throw new Error("zero_usd_micros");
  }

  await grantAllowanceUsdMicros({
    clientId: row.appId,
    externalUserId: row.externalUserId,
    amountUsdMicros: usdMicros,
    source: "onchain_deposit",
  });

  await db
    .update(signerDepositEvents)
    .set({
      status: "credited",
      usdMicrosCredited: usdMicros.toString(),
    })
    .where(eq(signerDepositEvents.id, eventId));

  return {
    status: "credited",
    fundTxHash: row.fundTxHash,
    usdMicrosCredited: usdMicros.toString(),
    ethWeiRealized: ethWeiRealized.toString(),
    swapTxHash: row.swapTxHash,
  };
}
