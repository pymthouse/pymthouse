import { eq } from "drizzle-orm";
import { getAddress, isAddress, type Address } from "viem";
import { db } from "@/db";
import { developerApps, oidcClients } from "@/db/schema";
import { getTurnkeyServerApiClient } from "@/lib/onramp/turnkey-client";

export type X402WalletResult = {
  address: string;
  source: "existing" | "provided" | "turnkey" | "facilitator_fallback";
  turnkeySubOrgId?: string | null;
  turnkeyWalletId?: string | null;
};

function normalizeAddress(address: string): string {
  if (!isAddress(address)) {
    throw new Error("Invalid Ethereum address");
  }
  return getAddress(address);
}

/**
 * Provision or assign the app's x402 payTo deposit wallet.
 * Prefer an explicitly provided address; otherwise try Turnkey CreateWallet
 * in the parent org (tagged for the app). Falls back to keeping any existing address.
 */
export async function provisionAppX402Wallet(input: {
  appId: string;
  address?: string | null;
}): Promise<X402WalletResult> {
  const rows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, input.appId))
    .limit(1);
  const app = rows[0];
  if (!app) {
    throw new Error("App not found");
  }

  if (input.address?.trim()) {
    const address = normalizeAddress(input.address.trim());
    await db
      .update(developerApps)
      .set({
        x402PayToAddress: address,
        x402Enabled: 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(developerApps.id, app.id));
    return { address, source: "provided" };
  }

  if (app.x402PayToAddress) {
    return {
      address: getAddress(app.x402PayToAddress as Address),
      source: "existing",
      turnkeySubOrgId: app.turnkeySubOrgId,
      turnkeyWalletId: app.turnkeyWalletId,
    };
  }

  try {
    const client = getTurnkeyServerApiClient();
    const walletName = `x402-${app.id.slice(0, 24)}`;
    const created = await client.createWallet({
      walletName,
      accounts: [
        {
          curve: "CURVE_SECP256K1",
          pathFormat: "PATH_FORMAT_BIP32",
          path: "m/44'/60'/0'/0/0",
          addressFormat: "ADDRESS_FORMAT_ETHEREUM",
        },
      ],
    });
    const address = created.addresses?.[0];
    const walletId = created.walletId;
    if (!address || !isAddress(address)) {
      throw new Error("Turnkey createWallet did not return an ETH address");
    }
    const checksummed = getAddress(address);
    const orgId =
      process.env.TURNKEY_ORG_ID?.trim() ||
      process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() ||
      null;
    await db
      .update(developerApps)
      .set({
        x402PayToAddress: checksummed,
        turnkeySubOrgId: orgId,
        turnkeyWalletId: walletId ?? null,
        x402Enabled: 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(developerApps.id, app.id));
    return {
      address: checksummed,
      source: "turnkey",
      turnkeySubOrgId: orgId,
      turnkeyWalletId: walletId ?? null,
    };
  } catch (err) {
    // Fall back: use facilitator address as temporary payTo only if explicitly allowed.
    if (process.env.X402_ALLOW_FACILITATOR_PAYTO_FALLBACK === "1") {
      const { getFacilitatorAccount } = await import("@/lib/x402/settle");
      const account = getFacilitatorAccount();
      await db
        .update(developerApps)
        .set({
          x402PayToAddress: account.address,
          x402Enabled: 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(developerApps.id, app.id));
      return { address: account.address, source: "facilitator_fallback" };
    }
    throw err instanceof Error
      ? err
      : new Error("Failed to provision Turnkey wallet");
  }
}

export async function assignM2mDepositWallet(input: {
  appId: string;
  address?: string | null;
}): Promise<X402WalletResult> {
  const appRows = await db
    .select()
    .from(developerApps)
    .where(eq(developerApps.id, input.appId))
    .limit(1);
  const app = appRows[0];
  if (!app?.m2mOidcClientId) {
    throw new Error("App has no M2M client");
  }

  const clientRows = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, app.m2mOidcClientId))
    .limit(1);
  const client = clientRows[0];
  if (!client) {
    throw new Error("M2M client not found");
  }

  if (input.address?.trim()) {
    const address = normalizeAddress(input.address.trim());
    await db
      .update(oidcClients)
      .set({ depositWalletAddress: address })
      .where(eq(oidcClients.id, client.id));
    return { address, source: "provided" };
  }

  if (client.depositWalletAddress) {
    return {
      address: getAddress(client.depositWalletAddress as Address),
      source: "existing",
    };
  }

  // Default: share the app payTo wallet with the M2M client.
  const appWallet = await provisionAppX402Wallet({ appId: app.id });
  await db
    .update(oidcClients)
    .set({ depositWalletAddress: appWallet.address })
    .where(eq(oidcClients.id, client.id));
  return { ...appWallet, source: appWallet.source };
}

export async function setAppX402Flags(input: {
  appId: string;
  x402Enabled?: boolean;
  onrampEnabled?: boolean;
  x402PayToAddress?: string | null;
}): Promise<void> {
  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.x402Enabled !== undefined) {
    updates.x402Enabled = input.x402Enabled ? 1 : 0;
  }
  if (input.onrampEnabled !== undefined) {
    updates.onrampEnabled = input.onrampEnabled ? 1 : 0;
  }
  if (input.x402PayToAddress !== undefined) {
    updates.x402PayToAddress = input.x402PayToAddress
      ? normalizeAddress(input.x402PayToAddress)
      : null;
  }
  await db
    .update(developerApps)
    .set(updates)
    .where(eq(developerApps.id, input.appId));
}
