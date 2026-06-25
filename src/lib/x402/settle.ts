import { encodeFunctionData, parseAbi } from "viem";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { resolveDepositPayerByWalletAddress } from "@/lib/turnkey/resolve-deposit-payer";
import { sendTurnkeyEthTransaction } from "@/lib/turnkey/send-transaction";
import { appendBuilderCodeSuffix } from "@/lib/x402/erc8021";
import { BASE_MAINNET_CAIP2, BASE_USDC_ADDRESS } from "@/lib/x402/types";
import type { VerifiedX402Payment } from "@/lib/x402/types";

const usdcAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

export function buildTransferWithAuthorizationCalldata(
  verified: VerifiedX402Payment,
): `0x${string}` {
  return encodeFunctionData({
    abi: usdcAbi,
    functionName: "transferWithAuthorization",
    args: [
      verified.payer,
      verified.payTo,
      verified.value,
      verified.validAfter,
      verified.validBefore,
      verified.nonce,
      verified.v,
      verified.r,
      verified.s,
    ],
  });
}

export async function settleX402OnBase(input: {
  verified: VerifiedX402Payment;
  builderCode?: string | null;
}): Promise<{ txHash: string }> {
  const calldata = appendBuilderCodeSuffix(
    buildTransferWithAuthorizationCalldata(input.verified),
    input.builderCode,
  );

  return sendTurnkeyEthTransaction({
    to: BASE_USDC_ADDRESS,
    data: calldata,
    caip2: BASE_MAINNET_CAIP2,
    sponsor: true,
  });
}

/**
 * USDC 6-decimal units map 1:1 to USD micros (e.g. 1 USDC = 1_000_000 micros).
 */
export function usdcRawToUsdMicros(amountRaw: bigint): bigint {
  return amountRaw;
}

export async function creditX402Settlement(input: {
  payer: string;
  amountRaw: bigint;
  appId?: string | null;
  externalUserId?: string | null;
}): Promise<{ appId: string; externalUserId: string; usdMicrosCredited: string }> {
  let appId = input.appId ?? null;
  let externalUserId = input.externalUserId ?? null;

  if (!appId || !externalUserId) {
    const payer = await resolveDepositPayerByWalletAddress(input.payer);
    if (!payer) {
      throw new Error("unmatched_payer");
    }
    appId = payer.appId;
    externalUserId = payer.externalUserId;
  }

  const usdMicros = usdcRawToUsdMicros(input.amountRaw);
  await grantAllowanceUsdMicros({
    clientId: appId,
    externalUserId,
    amountUsdMicros: usdMicros,
    source: "x402_settlement",
  });

  return {
    appId,
    externalUserId,
    usdMicrosCredited: usdMicros.toString(),
  };
}
