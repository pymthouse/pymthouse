import { verifyTypedData, type Hex } from "viem";
import {
  BASE_MAINNET_CAIP2,
  BASE_USDC_ADDRESS,
  type TransferWithAuthorization,
  type VerifiedX402Payment,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@/lib/x402/types";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function eip712Domain(chainId: number) {
  return {
    name: "USD Coin",
    version: "2",
    chainId,
    verifyingContract: BASE_USDC_ADDRESS,
  } as const;
}

export function parseX402PaymentHeader(header: string | null): X402PaymentPayload | null {
  if (!header?.trim()) return null;
  try {
    const decoded = Buffer.from(header.trim(), "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as X402PaymentPayload;
    if (parsed.scheme !== "exact" || !parsed.payload?.authorization) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildPaymentRequiredHeader(
  requirements: X402PaymentRequirements,
): string {
  return Buffer.from(JSON.stringify(requirements)).toString("base64");
}

export async function verifyEip3009Payment(input: {
  payment: X402PaymentPayload;
  requirements: X402PaymentRequirements;
  nowSec?: number;
}): Promise<VerifiedX402Payment> {
  const { payment, requirements } = input;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);

  if (payment.network !== BASE_MAINNET_CAIP2) {
    throw new Error("unsupported_network");
  }

  const auth = payment.payload.authorization;
  const value = BigInt(auth.value);
  const maxRequired = BigInt(requirements.maxAmountRequired);

  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    throw new Error("wrong_recipient");
  }
  if (value <= 0n || value > maxRequired) {
    throw new Error("invalid_amount");
  }

  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  if (BigInt(nowSec) < validAfter) {
    throw new Error("authorization_not_yet_valid");
  }
  if (BigInt(nowSec) > validBefore) {
    throw new Error("authorization_expired");
  }

  const chainId = 8453;
  const valid = await verifyTypedData({
    address: auth.from,
    domain: eip712Domain(chainId),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value,
      validAfter,
      validBefore,
      nonce: auth.nonce,
    },
    signature: payment.payload.signature as Hex,
  });

  if (!valid) {
    throw new Error("invalid_signature");
  }

  const sig = payment.payload.signature as Hex;
  const vByte = Number.parseInt(sig.slice(-2), 16);
  const r = `0x${sig.slice(2, 66)}` as `0x${string}`;
  const s = `0x${sig.slice(66, 130)}` as `0x${string}`;

  return {
    payer: auth.from,
    payTo: auth.to,
    value,
    nonce: auth.nonce,
    validAfter,
    validBefore,
    v: vByte >= 27 ? vByte - 27 : vByte,
    r,
    s,
  };
}
