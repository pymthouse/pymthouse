import {
  createWalletClient,
  http,
  getAddress,
  type Address,
  type Hex,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eip3009Abi } from "@/lib/x402/abi";
import { getX402PublicClient, resolveRequirementsAsset, resolveX402RpcUrl } from "@/lib/x402/client";
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  X402SettleResponse,
} from "@/lib/x402/schemas";
import { verifyExactEip3009Payment } from "@/lib/x402/verify";

/**
 * Facilitator gas wallet. Prefer X402_FACILITATOR_PRIVATE_KEY (0x-prefixed).
 * Pays gas only; never custodies user USDC.
 */
export function getFacilitatorAccount(): Account {
  const key = process.env.X402_FACILITATOR_PRIVATE_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing X402_FACILITATOR_PRIVATE_KEY — required to settle EIP-3009 transfers",
    );
  }
  const normalized = key.startsWith("0x") ? key : `0x${key}`;
  return privateKeyToAccount(normalized as Hex);
}

export async function settleExactEip3009Payment(input: {
  paymentPayload: X402PaymentPayload;
  paymentRequirements: X402PaymentRequirements;
}): Promise<X402SettleResponse> {
  const verified = await verifyExactEip3009Payment(input);
  if (!verified.isValid) {
    return {
      success: false,
      error: verified.invalidReason || "verification_failed",
      payer: verified.payer,
    };
  }

  const resolved = await getX402PublicClient(input.paymentRequirements.network);
  if (!resolved) {
    return { success: false, error: "unsupported_network" };
  }
  const { client, network } = resolved;
  const asset = resolveRequirementsAsset(
    network,
    input.paymentRequirements.asset,
    input.paymentRequirements.extra.name,
    input.paymentRequirements.extra.version,
  );
  if (!asset) {
    return { success: false, error: "unsupported_asset" };
  }

  const auth = input.paymentPayload.payload.authorization;
  let account: Account;
  try {
    account = getFacilitatorAccount();
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "facilitator_wallet_unavailable",
    };
  }

  const rpcUrl = await resolveX402RpcUrl(network);
  const wallet = createWalletClient({
    account,
    chain: network.chain,
    transport: http(rpcUrl),
  });

  try {
    const txHash = await wallet.writeContract({
      address: asset.address,
      abi: eip3009Abi,
      functionName: "transferWithAuthorization",
      args: [
        auth.from as Address,
        auth.to as Address,
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce as Hex,
        input.paymentPayload.payload.signature as Hex,
      ],
      chain: network.chain,
      account,
    });

    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    });
    if (receipt.status !== "success") {
      return {
        success: false,
        error: "settlement_reverted",
        txHash,
        networkId: network.network,
        payer: getAddress(auth.from),
      };
    }

    return {
      success: true,
      txHash,
      networkId: network.network,
      payer: getAddress(auth.from),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "settlement_failed",
      payer: getAddress(auth.from),
    };
  }
}

/** Convert USDC atomic units (6 decimals) to USD micros (1e-6 USD). */
export function usdcAtomicToUsdMicros(valueAtomic: string, decimals = 6): bigint {
  const value = BigInt(valueAtomic);
  if (decimals === 6) {
    return value;
  }
  if (decimals > 6) {
    return value / 10n ** BigInt(decimals - 6);
  }
  return value * 10n ** BigInt(6 - decimals);
}
