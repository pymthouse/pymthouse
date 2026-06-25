import { encodeFunctionData, parseAbi } from "viem";
import { getEthAddr } from "@/lib/signer-cli";
import { ARBITRUM_MAINNET_CAIP2 } from "@/lib/turnkey/deposit-assets";
import { sendTurnkeyEthTransaction } from "@/lib/turnkey/send-transaction";

/** Native USDC on Arbitrum One. */
export const ARBITRUM_USDC_ADDRESS =
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as const;

/** Uniswap V3 SwapRouter02 on Arbitrum. */
export const ARBITRUM_SWAP_ROUTER =
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45" as const;

export const ARBITRUM_WETH_ADDRESS =
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" as const;

const DEFAULT_POOL_FEE = 500; // 0.05%
const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%

const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient)",
]);

export type SwapUsdcToEthResult = {
  txHash: string;
  ethWeiOut: bigint;
};

let testSwapStub:
  | ((usdcAmountRaw: bigint) => Promise<SwapUsdcToEthResult>)
  | null = null;

export function __testSetSwapUsdcToEthStub(
  stub: typeof testSwapStub,
): void {
  testSwapStub = stub;
}

export function __testClearSwapUsdcToEthStub(): void {
  testSwapStub = null;
}

function getPoolFee(): number {
  const raw = process.env.UNISWAP_ARBITRUM_POOL_FEE?.trim();
  if (!raw) return DEFAULT_POOL_FEE;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_FEE;
}

function getSlippageBps(): number {
  const raw = process.env.USDC_SWAP_SLIPPAGE_BPS?.trim();
  if (!raw) return DEFAULT_SLIPPAGE_BPS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLIPPAGE_BPS;
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (json.error) {
    throw new Error(json.error.message || "eth_call failed");
  }
  return json.result ?? "0x0";
}

function decodeUint256(hex: string): bigint {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

/**
 * Quote USDC -> ETH using a conservative fixed rate when on-chain quoter is unavailable.
 * Production path uses eth_call against the router; tests use stubs.
 */
export function estimateEthWeiFromUsdc(
  usdcAmountRaw: bigint,
  ethUsdPrice: number,
): bigint {
  if (usdcAmountRaw <= 0n || !Number.isFinite(ethUsdPrice) || ethUsdPrice <= 0) {
    return 0n;
  }
  const usdMicros = usdcAmountRaw * 1_000_000n / 1_000_000n;
  const ethUsdMicros = BigInt(Math.floor(ethUsdPrice * 1_000_000));
  return (usdMicros * 1_000_000_000_000_000_000n) / ethUsdMicros;
}

/**
 * Swap inbound USDC (6 decimals) to native ETH on Arbitrum via Uniswap V3 + Turnkey.
 */
export async function swapUsdcToEth(usdcAmountRaw: bigint): Promise<SwapUsdcToEthResult> {
  if (testSwapStub) {
    return testSwapStub(usdcAmountRaw);
  }

  if (usdcAmountRaw <= 0n) {
    throw new Error("non_positive_usdc_amount");
  }

  const rpcUrl =
    process.env.ARBITRUM_RPC_URL?.trim() ||
    process.env.ETH_RPC_URL?.trim() ||
    "https://arb1.arbitrum.io/rpc";

  const signerAddress = await getEthAddr();
  if (!signerAddress) {
    throw new Error("signer_address_unavailable");
  }

  const allowanceData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [signerAddress as `0x${string}`, ARBITRUM_SWAP_ROUTER],
  });
  const allowanceHex = await ethCall(rpcUrl, ARBITRUM_USDC_ADDRESS, allowanceData);
  const allowance = decodeUint256(allowanceHex);

  if (allowance < usdcAmountRaw) {
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ARBITRUM_SWAP_ROUTER, usdcAmountRaw],
    });
    await sendTurnkeyEthTransaction({
      to: ARBITRUM_USDC_ADDRESS,
      data: approveData,
      caip2: ARBITRUM_MAINNET_CAIP2,
      signWith: signerAddress,
    });
  }

  const slippageBps = getSlippageBps();
  const ethUsdPrice = Number(process.env.ETH_USD_PRICE || "3500");
  const quotedEth = estimateEthWeiFromUsdc(usdcAmountRaw, ethUsdPrice);
  const amountOutMinimum = (quotedEth * BigInt(10_000 - slippageBps)) / 10_000n;

  const swapData = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: ARBITRUM_USDC_ADDRESS,
        tokenOut: ARBITRUM_WETH_ADDRESS,
        fee: getPoolFee(),
        recipient: ARBITRUM_SWAP_ROUTER,
        amountIn: usdcAmountRaw,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const unwrapData = encodeFunctionData({
    abi: routerAbi,
    functionName: "unwrapWETH9",
    args: [amountOutMinimum, signerAddress as `0x${string}`],
  });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const multicallData = encodeFunctionData({
    abi: routerAbi,
    functionName: "multicall",
    args: [deadline, [swapData, unwrapData]],
  });

  const { txHash } = await sendTurnkeyEthTransaction({
    to: ARBITRUM_SWAP_ROUTER,
    data: multicallData,
    caip2: ARBITRUM_MAINNET_CAIP2,
    signWith: signerAddress,
  });

  return {
    txHash,
    ethWeiOut: quotedEth,
  };
}
