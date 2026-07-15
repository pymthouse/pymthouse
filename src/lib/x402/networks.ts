import { arbitrum, arbitrumSepolia } from "viem/chains";
import type { Chain, Address } from "viem";

export type X402NetworkId = "eip155:42161" | "eip155:421614";

export type X402AssetConfig = {
  address: Address;
  /** EIP-712 domain name on the token contract. */
  name: string;
  /** EIP-712 domain version on the token contract. */
  version: string;
  decimals: number;
  symbol: string;
};

export type X402NetworkConfig = {
  network: X402NetworkId;
  chain: Chain;
  /** Native USDC (or test USDC) for the exact / eip3009 scheme. */
  usdc: X402AssetConfig;
  /** Optional override; falls back to signer_config.eth_rpc_url or public RPC. */
  defaultRpcUrl: string;
};

/** Arbitrum One native USDC. */
export const ARBITRUM_ONE_USDC: X402AssetConfig = {
  address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  name: "USD Coin",
  version: "2",
  decimals: 6,
  symbol: "USDC",
};

/** Circle USDC on Arbitrum Sepolia. */
export const ARBITRUM_SEPOLIA_USDC: X402AssetConfig = {
  address: "0x75faf114eafb1BDbe2F0316DF08252Ce6dD59575",
  name: "USD Coin",
  version: "2",
  decimals: 6,
  symbol: "USDC",
};

export const X402_NETWORKS: Record<X402NetworkId, X402NetworkConfig> = {
  "eip155:42161": {
    network: "eip155:42161",
    chain: arbitrum,
    usdc: ARBITRUM_ONE_USDC,
    defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
  },
  "eip155:421614": {
    network: "eip155:421614",
    chain: arbitrumSepolia,
    usdc: ARBITRUM_SEPOLIA_USDC,
    defaultRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  },
};

export function isX402NetworkId(value: string): value is X402NetworkId {
  return value === "eip155:42161" || value === "eip155:421614";
}

export function getX402Network(network: string): X402NetworkConfig | null {
  if (!isX402NetworkId(network)) {
    return null;
  }
  return X402_NETWORKS[network];
}

export function getAssetForNetwork(
  network: X402NetworkConfig,
  asset: string,
): X402AssetConfig | null {
  if (asset.toLowerCase() === network.usdc.address.toLowerCase()) {
    return network.usdc;
  }
  return null;
}

export function listSupportedKinds(): Array<{
  x402Version: number;
  scheme: string;
  network: X402NetworkId;
}> {
  return (Object.keys(X402_NETWORKS) as X402NetworkId[]).map((network) => ({
    x402Version: 2,
    scheme: "exact",
    network,
  }));
}
