import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { apiKeys, appUsers, developerApps, oidcClients } from "@/db/schema";
import { hashToken } from "@/lib/auth";
import { generateApiKeyValue } from "@/lib/oidc/programmatic-tokens";

export type ResolvedAppApiKey = {
  apiKeyId: string;
  developerAppId: string;
  publicClientId: string;
  appUserId: string;
  externalUserId: string;
  label: string | null;
};

export function maskApiKeyPrefix(keyPrefix: string | null | undefined): string {
  const raw = (keyPrefix ?? "pmth_").trim();
  if (raw.length <= 12) {
    return raw;
  }
  return raw.slice(0, 12);
}

export function maskApiKeySuffix(keyPrefix: string | null | undefined): string {
  const raw = (keyPrefix ?? "").trim();
  if (raw.length < 4) {
    return "••••";
  }
  return raw.slice(-4);
}

export async function resolveActiveAppApiKey(
  bearerToken: string,
  publicClientId: string,
): Promise<ResolvedAppApiKey | null> {
  const token = bearerToken.trim();
  if (!token.startsWith("pmth_")) {
    return null;
  }

  const keyHash = hashToken(token);
  const keyRows = await db
    .select({
      id: apiKeys.id,
      clientId: apiKeys.clientId,
      appUserId: apiKeys.appUserId,
      label: apiKeys.label,
      status: apiKeys.status,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  const row = keyRows[0];
  if (row?.status !== "active" || !row?.appUserId) {
    return null;
  }

  const bindingRows = await db
    .select({
      appUserId: appUsers.id,
      externalUserId: appUsers.externalUserId,
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
    })
    .from(appUsers)
    .innerJoin(developerApps, eq(appUsers.clientId, developerApps.id))
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(
      and(
        eq(appUsers.id, row.appUserId),
        eq(developerApps.id, row.clientId),
        eq(oidcClients.clientId, publicClientId),
        eq(appUsers.status, "active"),
      ),
    )
    .limit(1);
  const binding = bindingRows[0];
  if (!binding) {
    return null;
  }

  return {
    apiKeyId: row.id,
    developerAppId: binding.developerAppId,
    publicClientId: binding.publicClientId,
    appUserId: binding.appUserId,
    externalUserId: binding.externalUserId,
    label: row.label,
  };
}

export async function listAppUserApiKeys(input: {
  developerAppId: string;
  appUserId: string;
}) {
  const rows = await db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      keyPrefix: apiKeys.keyPrefix,
      status: apiKeys.status,
      createdAt: apiKeys.createdAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.clientId, input.developerAppId),
        eq(apiKeys.appUserId, input.appUserId),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    prefix: maskApiKeyPrefix(row.keyPrefix),
    suffix: maskApiKeySuffix(row.keyPrefix),
    status: row.status,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  }));
}

export async function createAppUserApiKey(input: {
  developerAppId: string;
  appUserId: string;
  label?: string | null;
}) {
  const apiKeyValue = generateApiKeyValue();
  const id = uuidv4();
  const createdAt = new Date().toISOString();

  await db.insert(apiKeys).values({
    id,
    keyHash: hashToken(apiKeyValue),
    keyPrefix: apiKeyValue.slice(0, 16),
    userId: null,
    appUserId: input.appUserId,
    clientId: input.developerAppId,
    subscriptionId: null,
    label: input.label?.trim() || null,
    status: "active",
    createdAt,
    revokedAt: null,
  });

  return {
    id,
    apiKey: apiKeyValue,
    prefix: maskApiKeyPrefix(apiKeyValue.slice(0, 16)),
    suffix: maskApiKeySuffix(apiKeyValue),
    label: input.label?.trim() || null,
    createdAt,
  };
}

export async function revokeAppUserApiKey(input: {
  developerAppId: string;
  appUserId: string;
  keyId: string;
}): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({
      status: "revoked",
      revokedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(apiKeys.id, input.keyId),
        eq(apiKeys.clientId, input.developerAppId),
        eq(apiKeys.appUserId, input.appUserId),
      ),
    )
    .returning({ id: apiKeys.id });

  return revoked.length > 0;
}
