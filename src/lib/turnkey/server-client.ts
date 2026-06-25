import { Turnkey, type TurnkeyApiClient } from "@turnkey/sdk-server";
import { normalizeWalletAddress } from "@/lib/turnkey";

/**
 * Server-side Turnkey client backed by the platform API key.
 *
 * Used for read-only attestation (e.g. `getWalletAccounts`) so wallet addresses
 * are sourced from Turnkey rather than trusted from client input. Returns null
 * when API credentials are not configured.
 */
let cachedClient: TurnkeyApiClient | null = null;

/** Test-only stubs for wallet attestation unit tests. */
let testEvmAddressesByOrg: Record<string, string[]> | null = null;
let testServerClientConfigured: boolean | null = null;

export function __testSetTurnkeyEvmAddressesStub(
  stub: Record<string, string[]> | null,
  serverConfigured: boolean | null = null,
): void {
  testEvmAddressesByOrg = stub;
  testServerClientConfigured = serverConfigured;
}

export function __testClearTurnkeyStubs(): void {
  testEvmAddressesByOrg = null;
  testServerClientConfigured = null;
}

export function getTurnkeyServerClient(): TurnkeyApiClient | null {
  if (testServerClientConfigured === false) return null;
  if (testServerClientConfigured === true) {
    return {} as TurnkeyApiClient;
  }
  if (cachedClient) return cachedClient;

  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY?.trim();
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY?.trim();
  const defaultOrganizationId =
    process.env.TURNKEY_ORG_ID?.trim() ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim();

  if (!apiPublicKey || !apiPrivateKey || !defaultOrganizationId) {
    return null;
  }

  const apiBaseUrl =
    process.env.TURNKEY_API_HOST?.trim() || "https://api.turnkey.com";

  const turnkey = new Turnkey({
    apiBaseUrl: apiBaseUrl.startsWith("http")
      ? apiBaseUrl
      : `https://${apiBaseUrl}`,
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId,
  });

  cachedClient = turnkey.apiClient();
  return cachedClient;
}

/**
 * Read the EVM wallet addresses Turnkey holds for a sub-organization.
 * Returns lowercase-normalized addresses; empty array when unavailable.
 */
export async function getTurnkeyEvmAddressesForOrg(
  organizationId: string,
): Promise<string[]> {
  if (testEvmAddressesByOrg) {
    return testEvmAddressesByOrg[organizationId] ?? [];
  }

  const client = getTurnkeyServerClient();
  if (!client) return [];

  const response = await client.getWalletAccounts({ organizationId });
  const addresses: string[] = [];
  for (const account of response.accounts) {
    if (account.addressFormat !== "ADDRESS_FORMAT_ETHEREUM") continue;
    const normalized = normalizeWalletAddress(account.address);
    if (normalized) addresses.push(normalized);
  }
  return addresses;
}

/**
 * True when Turnkey reports `address` among the sub-org's EVM wallet accounts.
 */
export async function turnkeyOrgOwnsAddress(
  organizationId: string,
  address: string,
): Promise<boolean> {
  const target = normalizeWalletAddress(address);
  if (!target) return false;
  const owned = await getTurnkeyEvmAddressesForOrg(organizationId);
  return owned.includes(target);
}
