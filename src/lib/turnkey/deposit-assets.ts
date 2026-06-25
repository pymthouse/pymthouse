/** Arbitrum mainnet CAIP-2 identifier for Turnkey balance webhooks. */
export const ARBITRUM_MAINNET_CAIP2 = "eip155:42161";

export const BALANCE_FINALIZED_EVENT_TYPES = new Set([
  "BALANCE_FINALIZED_UPDATES",
  "balances:finalized",
]);

export function isArbitrumMainnetCaip2(caip2: string | null | undefined): boolean {
  if (!caip2) return false;
  return caip2.trim().toLowerCase() === ARBITRUM_MAINNET_CAIP2;
}

export function isDepositOperation(operation: string | null | undefined): boolean {
  if (!operation) return false;
  return operation.trim().toLowerCase() === "deposit";
}

export type ParsedBalanceFinalizedMessage = {
  idempotencyKey: string;
  walletAddress: string;
  caip2: string;
  operation: string;
  transactionHash: string | null;
  amountWei: string;
  assetCaip19: string | null;
};

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function pickMessageRoot(payload: Record<string, unknown>): Record<string, unknown> {
  const candidates = [payload.message, payload.msg, payload.data, payload];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return payload;
}

/**
 * Parse a verified Turnkey balance-finalized webhook payload.
 */
export function parseBalanceFinalizedMessage(
  payload: unknown,
): ParsedBalanceFinalizedMessage | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const root = payload as Record<string, unknown>;
  const msg = pickMessageRoot(root);

  const idempotencyKey =
    readString(msg.idempotencyKey) ||
    readString(root.idempotencyKey) ||
    readString(msg.eventId);
  const walletAddress =
    readString(msg.walletAddress) ||
    readString(msg.address) ||
    readString(msg.monitoredAddress);
  const caip2 = readString(msg.caip2) || readString(msg.chain);
  const operation = readString(msg.operation) || readString(msg.type);
  const transactionHash =
    readString(msg.transactionHash) ||
    readString(msg.txHash) ||
    readString(msg.hash);
  const amountWei =
    readString(msg.value) ||
    readString(msg.amount) ||
    readString(msg.quantity) ||
    readString(msg.amountRaw);

  if (!idempotencyKey || !walletAddress || !caip2 || !operation || !amountWei) {
    return null;
  }

  const assetCaip19 =
    readString(msg.assetCaip19) ||
    readString(msg.asset) ||
    readString(msg.caip19);

  return {
    idempotencyKey,
    walletAddress,
    caip2,
    operation,
    transactionHash,
    amountWei,
    assetCaip19,
  };
}

export function isBalanceFinalizedEvent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const eventType = readString((payload as Record<string, unknown>).eventType);
  if (!eventType) return true;
  return BALANCE_FINALIZED_EVENT_TYPES.has(eventType);
}
