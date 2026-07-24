import { eq } from "drizzle-orm";
import { createPublicClient, http, type PublicClient } from "viem";
import { db } from "@/db";
import { signerConfig } from "@/db/schema";
import {
  getAssetForNetwork,
  getX402Network,
  type X402NetworkConfig,
} from "@/lib/x402/networks";

let cachedRpcUrl: string | null = null;

export async function resolveX402RpcUrl(
  network: X402NetworkConfig,
): Promise<string> {
  if (process.env.X402_RPC_URL?.trim()) {
    return process.env.X402_RPC_URL.trim();
  }
  if (network.network === "eip155:42161") {
    if (cachedRpcUrl) {
      return cachedRpcUrl;
    }
    const rows = await db
      .select({ ethRpcUrl: signerConfig.ethRpcUrl })
      .from(signerConfig)
      .where(eq(signerConfig.id, "default"))
      .limit(1);
    const fromSigner = rows[0]?.ethRpcUrl?.trim();
    if (fromSigner) {
      cachedRpcUrl = fromSigner;
      return fromSigner;
    }
    if (process.env.ETH_RPC_URL?.trim()) {
      cachedRpcUrl = process.env.ETH_RPC_URL.trim();
      return cachedRpcUrl;
    }
  }
  return network.defaultRpcUrl;
}

export async function getX402PublicClient(
  networkId: string,
): Promise<{ client: PublicClient; network: X402NetworkConfig } | null> {
  const network = getX402Network(networkId);
  if (!network) {
    return null;
  }
  const rpcUrl = await resolveX402RpcUrl(network);
  const client = createPublicClient({
    chain: network.chain,
    transport: http(rpcUrl),
  });
  return { client, network };
}

export function resolveRequirementsAsset(
  network: X402NetworkConfig,
  asset: string,
  extraName?: string,
  extraVersion?: string,
) {
  const configured = getAssetForNetwork(network, asset);
  if (!configured) {
    return null;
  }
  return {
    ...configured,
    name: extraName?.trim() || configured.name,
    version: extraVersion?.trim() || configured.version,
  };
}
