import {
  recoverTypedDataAddress,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { x402Payments } from "@/db/schema";
import { eip3009Abi, eip3009Types } from "@/lib/x402/abi";
import { getX402PublicClient, resolveRequirementsAsset } from "@/lib/x402/client";
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  X402VerifyResponse,
} from "@/lib/x402/schemas";

function addressesEqual(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

export async function verifyExactEip3009Payment(input: {
  paymentPayload: X402PaymentPayload;
  paymentRequirements: X402PaymentRequirements;
}): Promise<X402VerifyResponse> {
  const { paymentPayload, paymentRequirements } = input;
  const auth = paymentPayload.payload.authorization;

  if (paymentPayload.scheme !== paymentRequirements.scheme) {
    return { isValid: false, invalidReason: "scheme_mismatch" };
  }
  if (paymentPayload.network !== paymentRequirements.network) {
    return { isValid: false, invalidReason: "network_mismatch" };
  }
  if (!addressesEqual(auth.to, paymentRequirements.payTo)) {
    return { isValid: false, invalidReason: "pay_to_mismatch" };
  }
  if (BigInt(auth.value) < BigInt(paymentRequirements.amount)) {
    return { isValid: false, invalidReason: "insufficient_value" };
  }

  const now = Math.floor(Date.now() / 1000);
  const validAfter = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);
  if (Number.isFinite(validAfter) && now < validAfter) {
    return { isValid: false, invalidReason: "authorization_not_yet_valid" };
  }
  if (Number.isFinite(validBefore) && now >= validBefore) {
    return { isValid: false, invalidReason: "authorization_expired" };
  }

  const resolved = await getX402PublicClient(paymentRequirements.network);
  if (!resolved) {
    return { isValid: false, invalidReason: "unsupported_network" };
  }
  const { client, network } = resolved;
  const asset = resolveRequirementsAsset(
    network,
    paymentRequirements.asset,
    paymentRequirements.extra.name,
    paymentRequirements.extra.version,
  );
  if (!asset) {
    return { isValid: false, invalidReason: "unsupported_asset" };
  }
  if (!addressesEqual(paymentRequirements.asset, asset.address)) {
    return { isValid: false, invalidReason: "asset_mismatch" };
  }

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: asset.name,
        version: asset.version,
        chainId: network.chain.id,
        verifyingContract: asset.address,
      },
      types: eip3009Types,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as Address,
        to: auth.to as Address,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as Hex,
      },
      signature: paymentPayload.payload.signature as Hex,
    });
  } catch {
    return { isValid: false, invalidReason: "invalid_signature" };
  }

  if (!addressesEqual(recovered, auth.from)) {
    return { isValid: false, invalidReason: "signature_mismatch" };
  }

  const existing = await db
    .select({ id: x402Payments.id, status: x402Payments.status })
    .from(x402Payments)
    .where(
      and(
        eq(x402Payments.asset, asset.address.toLowerCase()),
        eq(x402Payments.fromAddress, auth.from.toLowerCase()),
        eq(x402Payments.nonce, auth.nonce.toLowerCase()),
      ),
    )
    .limit(1);
  if (existing[0]?.status === "settled") {
    return { isValid: false, invalidReason: "nonce_already_settled" };
  }

  try {
    const used = await client.readContract({
      address: asset.address,
      abi: eip3009Abi,
      functionName: "authorizationState",
      args: [auth.from as Address, auth.nonce as Hex],
    });
    if (used) {
      return { isValid: false, invalidReason: "nonce_already_used_onchain" };
    }

    const balance = await client.readContract({
      address: asset.address,
      abi: eip3009Abi,
      functionName: "balanceOf",
      args: [auth.from as Address],
    });
    if (balance < BigInt(auth.value)) {
      return { isValid: false, invalidReason: "insufficient_balance" };
    }
  } catch (err) {
    return {
      isValid: false,
      invalidReason:
        err instanceof Error
          ? `rpc_error:${err.message}`
          : "rpc_error",
    };
  }

  return {
    isValid: true,
    payer: getAddress(auth.from),
  };
}
