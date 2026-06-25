import { db } from "@/db/index";
import { developerApps, endUsers, signerConfig, users } from "@/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { getEthAddr } from "@/lib/signer-cli";
import { normalizeWalletAddress } from "@/lib/turnkey";
import {
  getTurnkeyServerClient,
  turnkeyOrgOwnsAddress,
} from "@/lib/turnkey/server-client";

export type ResolvedDepositPayer =
  | {
      kind: "end_user";
      appId: string;
      externalUserId: string;
      endUserId: string;
    }
  | {
      kind: "developer";
      userId: string;
      appId: string;
      externalUserId: string;
    };

/**
 * Resolve the shared company signer ETH address (CLI first, then DB cache).
 */
export async function getSharedSignerEthAddress(): Promise<string | null> {
  const fromCli = normalizeWalletAddress(await getEthAddr());
  if (fromCli) {
    return fromCli;
  }

  const rows = await db
    .select({ ethAddress: signerConfig.ethAddress })
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);

  return normalizeWalletAddress(rows[0]?.ethAddress ?? null);
}

export function getArbitrumRpcUrl(): string {
  return (
    process.env.ARBITRUM_RPC_URL?.trim() ||
    process.env.ETH_RPC_URL?.trim() ||
    "https://arb1.arbitrum.io/rpc"
  );
}

/**
 * Fetch the `from` address for an Arbitrum transaction hash.
 */
export async function getTransactionFromAddress(
  txHash: string,
  rpcUrl = getArbitrumRpcUrl(),
): Promise<string | null> {
  const hash = txHash.trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) {
    return null;
  }

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionByHash",
      params: [hash],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Arbitrum RPC HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    result?: { from?: string } | null;
    error?: { message?: string };
  };

  if (json.error) {
    throw new Error(json.error.message || "Arbitrum RPC error");
  }

  return normalizeWalletAddress(json.result?.from ?? null);
}

/**
 * Best-effort corroboration that the matched identity's Turnkey sub-org actually
 * owns the payer address. When the server API key is configured and the sub-org
 * does NOT own the address, the match is rejected to prevent mis-attribution.
 * When Turnkey is unconfigured or the identity has no sub-org, the DB match
 * (backed by the unique wallet index) stands.
 */
async function corroborateOrgOwnsAddress(
  turnkeySubOrgId: string | null,
  fromAddress: string,
): Promise<boolean> {
  if (!turnkeySubOrgId) return true;
  if (!getTurnkeyServerClient()) return true;
  return turnkeyOrgOwnsAddress(turnkeySubOrgId, fromAddress);
}

/**
 * Map a payer wallet address to an OpenMeter billable identity.
 * Prefers app-scoped end users; falls back to developer owners via user:{id}.
 */
export async function resolveDepositPayerByWalletAddress(
  fromAddress: string,
): Promise<ResolvedDepositPayer | null> {
  const normalized = normalizeWalletAddress(fromAddress);
  if (!normalized) {
    return null;
  }

  const endUserRows = await db
    .select()
    .from(endUsers)
    .where(
      and(
        eq(endUsers.walletAddress, normalized),
        isNotNull(endUsers.appId),
        isNotNull(endUsers.externalUserId),
      ),
    )
    .limit(2);

  if (endUserRows.length > 1) {
    return null;
  }

  if (endUserRows.length === 1) {
    const row = endUserRows[0];
    if (row.appId && row.externalUserId) {
      const ok = await corroborateOrgOwnsAddress(
        row.turnkeySubOrgId,
        normalized,
      );
      if (!ok) return null;
      return {
        kind: "end_user",
        appId: row.appId,
        externalUserId: row.externalUserId,
        endUserId: row.id,
      };
    }
  }

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.walletAddress, normalized))
    .limit(1);
  const developer = userRows[0];
  if (!developer) {
    return null;
  }

  const ok = await corroborateOrgOwnsAddress(
    developer.turnkeySubOrgId,
    normalized,
  );
  if (!ok) return null;

  const appRows = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(eq(developerApps.ownerId, developer.id))
    .limit(1);
  const app = appRows[0];
  if (!app) {
    return null;
  }

  return {
    kind: "developer",
    userId: developer.id,
    appId: app.id,
    externalUserId: `user:${developer.id}`,
  };
}

export type DepositAttribution = {
  fromAddress: string;
  kind: "end_user" | "developer";
  appId: string;
  clientId: string;
  externalUserId: string;
  endUserId?: string;
  turnkeyOrgId?: string | null;
};

/**
 * Resolve a payer wallet address to billing attribution, including public clientId.
 */
export async function resolveDepositAttribution(
  fromAddress: string,
): Promise<DepositAttribution | null> {
  const normalized = normalizeWalletAddress(fromAddress);
  if (!normalized) {
    return null;
  }

  const payer = await resolveDepositPayerByWalletAddress(normalized);
  if (!payer) {
    return null;
  }

  if (payer.kind === "end_user") {
    const endUserRows = await db
      .select({ turnkeySubOrgId: endUsers.turnkeySubOrgId })
      .from(endUsers)
      .where(eq(endUsers.id, payer.endUserId))
      .limit(1);
    return {
      fromAddress: normalized,
      kind: "end_user",
      appId: payer.appId,
      clientId: payer.appId,
      externalUserId: payer.externalUserId,
      endUserId: payer.endUserId,
      turnkeyOrgId: endUserRows[0]?.turnkeySubOrgId ?? null,
    };
  }

  return {
    fromAddress: normalized,
    kind: "developer",
    appId: payer.appId,
    clientId: payer.appId,
    externalUserId: payer.externalUserId,
    turnkeyOrgId: null,
  };
}
