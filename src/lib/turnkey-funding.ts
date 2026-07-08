import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { turnkeyFundingEvents } from "@/db/schema";
import { fundDepositAndReserve, getEthAddr } from "@/lib/signer-cli";

const DEFAULT_TURNKEY_FUNDING_CAIP2 = "eip155:42161";
const DEFAULT_GAS_BUFFER_WEI = 100_000_000_000_000n; // 0.0001 ETH
const DEFAULT_MIN_FUND_WEI = 1_000_000_000_000_000n; // 0.001 ETH
const STALE_PENDING_MS = 10 * 60 * 1000;

export type TurnkeyBalanceWebhookPayload = {
  type: string;
  organizationId?: string;
  parentOrganizationId?: string;
  msg?: {
    operation?: string;
    caip2?: string;
    txHash?: string;
    address?: string;
    idempotencyKey?: string;
    asset?: {
      symbol?: string;
      name?: string;
      decimals?: string;
      caip19?: string;
      amount?: string;
    };
    block?: {
      number?: string;
      hash?: string;
      timestamp?: string;
    };
  };
};

export type TurnkeyFundingConfig = {
  caip2: string;
  gasBufferWei: bigint;
  minFundWei: bigint;
};

export function getTurnkeyFundingConfig(): TurnkeyFundingConfig {
  return {
    caip2:
      process.env.TURNKEY_FUNDING_CAIP2?.trim() || DEFAULT_TURNKEY_FUNDING_CAIP2,
    gasBufferWei: parseWeiEnv(
      process.env.TICKET_FUNDING_GAS_BUFFER_WEI,
      DEFAULT_GAS_BUFFER_WEI,
    ),
    minFundWei: parseWeiEnv(
      process.env.TICKET_FUNDING_MIN_WEI,
      DEFAULT_MIN_FUND_WEI,
    ),
  };
}

function parseWeiEnv(value: string | undefined, fallback: bigint): bigint {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = BigInt(trimmed);
    if (parsed < 0n) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function isNativeEthAsset(asset: NonNullable<TurnkeyBalanceWebhookPayload["msg"]>["asset"]): boolean {
  if (!asset) return false;
  const symbol = asset.symbol?.trim().toUpperCase();
  if (symbol === "ETH") return true;
  const caip19 = asset.caip19?.trim().toLowerCase();
  return !!caip19 && caip19.endsWith("/slip44:60");
}

export function parseTurnkeyBalanceWebhookPayload(
  rawBody: string,
): TurnkeyBalanceWebhookPayload | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as TurnkeyBalanceWebhookPayload;
  } catch {
    return null;
  }
}

export async function shouldProcessTurnkeyDeposit(
  payload: TurnkeyBalanceWebhookPayload,
  config: TurnkeyFundingConfig,
  options?: { signerAddress?: string | null },
): Promise<
  | { action: "skip"; reason: string }
  | {
      action: "fund";
      idempotencyKey: string;
      txHash: string;
      address: string;
      amountWei: bigint;
      fundWei: bigint;
    }
> {
  if (payload.type !== "balances:finalized") {
    return { action: "skip", reason: "not_finalized" };
  }

  const msg = payload.msg;
  if (!msg || msg.operation !== "deposit") {
    return { action: "skip", reason: "not_deposit" };
  }

  if (msg.caip2 !== config.caip2) {
    return { action: "skip", reason: "wrong_chain" };
  }

  if (!isNativeEthAsset(msg.asset)) {
    return { action: "skip", reason: "not_native_eth" };
  }

  const address = msg.address?.trim();
  const idempotencyKey = msg.idempotencyKey?.trim();
  const txHash = msg.txHash?.trim();
  const amountRaw = msg.asset?.amount?.trim();

  if (!address || !idempotencyKey || !txHash || !amountRaw) {
    return { action: "skip", reason: "missing_fields" };
  }

  let amountWei: bigint;
  try {
    amountWei = BigInt(amountRaw);
    if (amountWei <= 0n) {
      return { action: "skip", reason: "non_positive_amount" };
    }
  } catch {
    return { action: "skip", reason: "invalid_amount" };
  }

  const signerAddress =
    options?.signerAddress !== undefined
      ? options.signerAddress
      : await getEthAddr();
  if (!signerAddress) {
    throw new Error("signer eth address unavailable");
  }
  if (address.toLowerCase() !== signerAddress.toLowerCase()) {
    return { action: "skip", reason: "wrong_address" };
  }

  const fundWei = amountWei - config.gasBufferWei;
  if (fundWei <= 0n) {
    return { action: "skip", reason: "below_gas_buffer" };
  }
  if (fundWei < config.minFundWei) {
    return { action: "skip", reason: "below_min_fund" };
  }

  return {
    action: "fund",
    idempotencyKey,
    txHash,
    address,
    amountWei,
    fundWei,
  };
}

function isStalePending(createdAt: string): boolean {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return true;
  return Date.now() - createdMs >= STALE_PENDING_MS;
}

export async function claimTurnkeyFundingEvent(input: {
  idempotencyKey: string;
  txHash: string;
  address: string;
  amountWei: bigint;
  fundWei: bigint;
}): Promise<
  | { action: "skip"; reason: string }
  | { action: "fund"; eventId: string }
> {
  const now = new Date().toISOString();
  const eventId = uuidv4();

  try {
    await db.insert(turnkeyFundingEvents).values({
      id: eventId,
      idempotencyKey: input.idempotencyKey,
      txHash: input.txHash,
      address: input.address,
      amountWei: input.amountWei.toString(),
      fundedWei: input.fundWei.toString(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return { action: "fund", eventId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("unique")) {
      throw error;
    }
  }

  const existingRows = await db
    .select()
    .from(turnkeyFundingEvents)
    .where(eq(turnkeyFundingEvents.idempotencyKey, input.idempotencyKey))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    throw new Error("idempotency conflict without existing row");
  }

  if (existing.status === "funded" || existing.status === "skipped") {
    return { action: "skip", reason: `already_${existing.status}` };
  }

  if (existing.status === "pending" && !isStalePending(existing.createdAt)) {
    return { action: "skip", reason: "in_progress" };
  }

  await db
    .update(turnkeyFundingEvents)
    .set({
      status: "pending",
      fundedWei: input.fundWei.toString(),
      error: null,
      updatedAt: now,
    })
    .where(eq(turnkeyFundingEvents.id, existing.id));

  return { action: "fund", eventId: existing.id };
}

export async function markTurnkeyFundingSkipped(
  eventId: string,
  reason: string,
): Promise<void> {
  await db
    .update(turnkeyFundingEvents)
    .set({
      status: "skipped",
      error: reason,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(turnkeyFundingEvents.id, eventId));
}

export async function markTurnkeyFundingFunded(eventId: string): Promise<void> {
  await db
    .update(turnkeyFundingEvents)
    .set({
      status: "funded",
      error: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(turnkeyFundingEvents.id, eventId));
}

export async function markTurnkeyFundingFailed(
  eventId: string,
  error: string,
): Promise<void> {
  await db
    .update(turnkeyFundingEvents)
    .set({
      status: "failed",
      error,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(turnkeyFundingEvents.id, eventId));
}

export async function executeTurnkeyFunding(
  fundWei: bigint,
  eventId: string,
): Promise<void> {
  await fundDepositAndReserve(fundWei.toString(), "0");
  await markTurnkeyFundingFunded(eventId);
}
