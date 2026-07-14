import { Turnkey } from "@turnkey/sdk-server";

let cachedClient: ReturnType<Turnkey["apiClient"]> | null = null;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function turnkeyParentOrganizationId(): string {
  return (
    process.env.TURNKEY_ORG_ID?.trim() ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() ||
    ""
  );
}

export function getTurnkeyServerApiClient(): ReturnType<Turnkey["apiClient"]> {
  if (cachedClient) {
    return cachedClient;
  }

  const organizationId = turnkeyParentOrganizationId();
  if (!organizationId) {
    throw new Error("Missing required env: TURNKEY_ORG_ID or NEXT_PUBLIC_ORGANIZATION_ID");
  }
  const apiPublicKey = requireEnv("TURNKEY_API_PUBLIC_KEY");
  const apiPrivateKey = requireEnv("TURNKEY_API_PRIVATE_KEY");
  const apiHost = process.env.TURNKEY_API_HOST?.trim() || "api.turnkey.com";

  const turnkey = new Turnkey({
    apiBaseUrl: `https://${apiHost}`,
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  });

  cachedClient = turnkey.apiClient();
  return cachedClient;
}

export async function verifyOnRampTransactionStatus(input: {
  transactionId: string;
  /** Sub-org that owns the on-ramp tx. Falls back to parent org env if omitted. */
  organizationId?: string;
  refresh?: boolean;
}): Promise<string> {
  const client = getTurnkeyServerApiClient();
  const organizationId =
    input.organizationId?.trim() || turnkeyParentOrganizationId();
  if (!organizationId) {
    throw new Error("Missing required env: TURNKEY_ORG_ID or NEXT_PUBLIC_ORGANIZATION_ID");
  }
  const response = await client.getOnRampTransactionStatus({
    organizationId,
    transactionId: input.transactionId,
    refresh: input.refresh ?? true,
  });
  return response.transactionStatus?.trim() || "";
}
