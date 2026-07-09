import { Turnkey } from "@turnkey/sdk-server";

let cachedClient: ReturnType<Turnkey["apiClient"]> | null = null;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export function getTurnkeyServerApiClient(): ReturnType<Turnkey["apiClient"]> {
  if (cachedClient) {
    return cachedClient;
  }

  const organizationId = requireEnv("TURNKEY_ORG_ID");
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
  refresh?: boolean;
}): Promise<string> {
  const client = getTurnkeyServerApiClient();
  const organizationId = requireEnv("TURNKEY_ORG_ID");
  const response = await client.getOnRampTransactionStatus({
    organizationId,
    transactionId: input.transactionId,
    refresh: input.refresh ?? true,
  });
  return response.transactionStatus?.trim() || "";
}
