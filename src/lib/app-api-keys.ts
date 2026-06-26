import { and, eq, or } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { apiKeys, appUsers, developerApps, oidcClients, users } from "@/db/schema";
import { hashToken } from "@/lib/auth";
import { generateApiKeyValue } from "@/lib/oidc/programmatic-tokens";
import { apiKeyLookupHashes } from "@/lib/token-hash";
import { resolveOrCreateAppUser } from "@/lib/usage/record-signed-ticket";

export type ResolvedAppApiKey = {
  apiKeyId: string;
  developerAppId: string;
  publicClientId: string;
  appUserId: string;
  externalUserId: string;
  label: string | null;
};

type ActiveApiKeyRow = {
  id: string;
  clientId: string;
  appUserId: string | null;
  userId: string | null;
  label: string | null;
  status: string;
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

async function findActiveApiKeyRow(token: string): Promise<ActiveApiKeyRow | null> {
  const lookupHashes = apiKeyLookupHashes(token);
  const keyRows = await db
    .select({
      id: apiKeys.id,
      clientId: apiKeys.clientId,
      appUserId: apiKeys.appUserId,
      userId: apiKeys.userId,
      label: apiKeys.label,
      status: apiKeys.status,
    })
    .from(apiKeys)
    .where(
      lookupHashes.length === 1
        ? eq(apiKeys.keyHash, lookupHashes[0]!)
        : or(
            eq(apiKeys.keyHash, lookupHashes[0]!),
            eq(apiKeys.keyHash, lookupHashes[1]!),
          ),
    )
    .limit(1);
  const row = keyRows[0];
  if (!row || row.status !== "active") {
    return null;
  }
  return row;
}

async function resolveAppUserBoundApiKey(
  row: ActiveApiKeyRow,
  publicClientId: string,
): Promise<ResolvedAppApiKey | null> {
  if (!row.appUserId) {
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

/**
 * Legacy app-level keys (pre per-app-user keys) stored `users.id` on the row
 * without `app_user_id`. Map them to an app user for signer-session exchange.
 */
async function resolveLegacyProviderApiKey(
  row: ActiveApiKeyRow,
  publicClientId: string,
): Promise<ResolvedAppApiKey | null> {
  if (!row.userId) {
    return null;
  }

  const bindingRows = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(
      and(
        eq(developerApps.id, row.clientId),
        eq(oidcClients.clientId, publicClientId),
      ),
    )
    .limit(1);
  const binding = bindingRows[0];
  if (!binding) {
    return null;
  }

  const ownerRows = await db
    .select({
      id: users.id,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  const owner = ownerRows[0];
  if (!owner) {
    return null;
  }

  const externalUserId = (owner.email?.trim() || owner.id).trim();
  const appUser = await resolveOrCreateAppUser({
    clientId: row.clientId,
    externalUserId,
  });

  return {
    apiKeyId: row.id,
    developerAppId: binding.developerAppId,
    publicClientId: binding.publicClientId,
    appUserId: appUser.id,
    externalUserId: appUser.externalUserId,
    label: row.label,
  };
}

export async function resolveActiveAppApiKey(
  bearerToken: string,
  publicClientId: string,
): Promise<ResolvedAppApiKey | null> {
  const token = bearerToken.trim();
  if (!token.startsWith("pmth_")) {
    return null;
  }

  const row = await findActiveApiKeyRow(token);
  if (!row) {
    return null;
  }

  if (row.appUserId) {
    return resolveAppUserBoundApiKey(row, publicClientId);
  }

  return resolveLegacyProviderApiKey(row, publicClientId);
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
