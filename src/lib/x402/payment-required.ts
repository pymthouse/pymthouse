import { eq } from "drizzle-orm";
import { db } from "@/db";
import { developerApps } from "@/db/schema";
import { ARBITRUM_ONE_USDC, getX402Network } from "@/lib/x402/networks";
import type { X402PaymentRequirements } from "@/lib/x402/schemas";

/**
 * Build a spec-compliant x402 PaymentRequirements object for mint-gate 402s.
 * Returns null when the app has no x402 deposit wallet configured.
 */
export async function buildMintGatePaymentRequirements(input: {
  appId: string;
  /** Atomic USDC amount; default $0.01. */
  amountAtomic?: string;
  network?: string;
}): Promise<X402PaymentRequirements | null> {
  const rows = await db
    .select({
      x402Enabled: developerApps.x402Enabled,
      x402PayToAddress: developerApps.x402PayToAddress,
    })
    .from(developerApps)
    .where(eq(developerApps.id, input.appId))
    .limit(1);
  const app = rows[0];
  if (!app || app.x402Enabled !== 1 || !app.x402PayToAddress) {
    return null;
  }

  const networkId = input.network || "eip155:42161";
  const network = getX402Network(networkId);
  const asset = network?.usdc ?? ARBITRUM_ONE_USDC;

  return {
    scheme: "exact",
    network: networkId,
    asset: asset.address,
    amount: input.amountAtomic || "10000",
    payTo: app.x402PayToAddress,
    maxTimeoutSeconds: 300,
    extra: {
      name: asset.name,
      version: asset.version,
      assetTransferMethod: "eip3009",
    },
  };
}

export function encodePaymentRequiredHeader(
  accepts: X402PaymentRequirements[],
  error = "Payment required",
): string {
  const payload = {
    x402Version: 2,
    error,
    accepts,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}
