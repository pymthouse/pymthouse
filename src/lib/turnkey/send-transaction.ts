import { getTurnkeyServerClient } from "@/lib/turnkey/server-client";
import { getEthAddr } from "@/lib/signer-cli";

export type SendTurnkeyTransactionInput = {
  to: `0x${string}`;
  data?: `0x${string}`;
  valueWei?: bigint;
  caip2: string;
  sponsor?: boolean;
  signWith?: string;
  organizationId?: string;
};

export type SendTurnkeyTransactionResult = {
  txHash: string;
};

let testSendTransactionStub:
  | ((input: SendTurnkeyTransactionInput) => Promise<SendTurnkeyTransactionResult>)
  | null = null;

export function __testSetSendTransactionStub(
  stub: typeof testSendTransactionStub,
): void {
  testSendTransactionStub = stub;
}

export function __testClearSendTransactionStub(): void {
  testSendTransactionStub = null;
}

function chainIdFromCaip2(caip2: string): string {
  const match = /^eip155:(\d+)$/i.exec(caip2.trim());
  if (!match) {
    throw new Error(`unsupported_caip2:${caip2}`);
  }
  return match[1];
}

/**
 * Broadcast an EVM transaction via Turnkey ethSendTransaction and wait for inclusion.
 */
export async function sendTurnkeyEthTransaction(
  input: SendTurnkeyTransactionInput,
): Promise<SendTurnkeyTransactionResult> {
  if (testSendTransactionStub) {
    return testSendTransactionStub(input);
  }

  const client = getTurnkeyServerClient();
  if (!client) {
    throw new Error("Turnkey API not configured");
  }

  const signWith = input.signWith ?? (await getEthAddr());
  if (!signWith) {
    throw new Error("signer_address_unavailable");
  }

  const organizationId =
    input.organizationId?.trim() ||
    process.env.TURNKEY_ORG_ID?.trim() ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim();
  if (!organizationId) {
    throw new Error("TURNKEY_ORG_ID not configured");
  }

  const response = await client.ethSendTransaction({
    organizationId,
    type: "ACTIVITY_TYPE_ETH_SEND_TRANSACTION",
    timestampMs: String(Date.now()),
    parameters: {
      signWith,
      type: "TRANSACTION_TYPE_ETHEREUM",
      sponsor: input.sponsor ?? false,
      transaction: {
        to: input.to,
        value: `0x${(input.valueWei ?? 0n).toString(16)}`,
        data: input.data ?? "0x",
        chainId: chainIdFromCaip2(input.caip2),
      },
    },
  } as never);

  const activity = response.activity as {
    result?: {
      ethSendTransactionResult?: { transactionHash?: string };
      sendTransactionStatusId?: string;
    };
  };

  const immediateHash =
    activity?.result?.ethSendTransactionResult?.transactionHash;
  if (immediateHash && /^0x[a-fA-F0-9]{64}$/.test(immediateHash)) {
    return { txHash: immediateHash };
  }

  const statusId = activity?.result?.sendTransactionStatusId;
  if (!statusId) {
    throw new Error("ethSendTransaction missing transaction hash");
  }

  const polled = await client.pollTransactionStatus({
    organizationId,
    sendTransactionStatusId: statusId,
    timeoutMs: 120_000,
  });

  const txHash = polled.eth?.txHash;
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error("ethSendTransaction poll missing transaction hash");
  }

  return { txHash };
}
