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

/** Presented composite: `app_<24hex>_<secret>` (underscore separator for copy UX). */
const COMPOSITE_API_KEY_RE = /^(app_[a-f0-9]{24})_(.+)$/;
/** Reject client-secret shaped secret segments. */
const CLIENT_SECRET_SEGMENT_RE = /(?:^|_)cs_/;

/**
 * Split a composite credential `app_<24hex>_<secret>` into parts.
 * Returns null for bare API keys, JWTs, or malformed forms.
 */
export function splitCompositeApiKey(
  token: string,
): { publicClientId: string; apiKey: string } | null {
  const trimmed = token.trim();
  const match = COMPOSITE_API_KEY_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  const publicClientId = match[1]!;
  const apiKey = match[2]!;
  if (!apiKey || CLIENT_SECRET_SEGMENT_RE.test(apiKey)) {
    return null;
  }
  return { publicClientId, apiKey };
}

/**
 * Format the one-time presented API key as `app_<24hex>_<bareApiKey>`.
 * The bare key is kept as-is (including any operator storage prefix).
 */
export function formatCompositeApiKey(
  publicClientId: string,
  bareApiKey: string,
): string {
  return `${publicClientId.trim()}_${bareApiKey.trim()}`;
}

/**
 * Normalize a subject_token that may be a bare stored API key, opaque hex
 * secret, or composite `app_*_*`. When composite, the client-id segment
 * must match `publicClientId`.
 */
export function normalizeAppApiKeySubjectToken(
  subjectToken: string,
  publicClientId: string,
): string | null {
  const trimmed = subjectToken.trim();
  const composite = splitCompositeApiKey(trimmed);
  if (composite) {
    if (composite.publicClientId !== publicClientId.trim()) {
      return null;
    }
    return rehydrateStoredApiKey(composite.apiKey);
  }
  return rehydrateStoredApiKey(trimmed);
}

/** Map a subject secret back to the hashed/stored key value. */
function rehydrateStoredApiKey(secret: string): string | null {
  const trimmed = secret.trim();
  if (!trimmed || CLIENT_SECRET_SEGMENT_RE.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("pmth_")) {
    return trimmed.startsWith("pmth_cs_") ? null : trimmed;
  }
  if (!/^[a-f0-9]+$/i.test(trimmed)) {
    return null;
  }
  return `pmth_${trimmed}`;
}

export async function resolveActiveAppApiKey(
  bearerToken: string,
  publicClientId: string,
): Promise<ResolvedAppApiKey | null> {
  const token = normalizeAppApiKeySubjectToken(bearerToken, publicClientId);
  if (!token) {
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

/**
 * Resolve an API key Bearer without a caller-supplied public client id.
 * Composite `app_*_*` keys carry the client id; bare keys are looked up by hash.
 */
export async function resolveActiveAppApiKeyByBearer(
  bearerToken: string,
): Promise<ResolvedAppApiKey | null> {
  const trimmed = bearerToken.trim();
  if (!trimmed) {
    return null;
  }

  const composite = splitCompositeApiKey(trimmed);
  if (composite) {
    return resolveActiveAppApiKey(trimmed, composite.publicClientId);
  }

  const token = rehydrateStoredApiKey(trimmed);
  if (!token) {
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
  /** Public OIDC client id (`app_*`); when set, returned `apiKey` is composite. */
  publicClientId?: string | null;
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

  const publicClientId = input.publicClientId?.trim() || "";
  const presented = publicClientId
    ? formatCompositeApiKey(publicClientId, apiKeyValue)
    : apiKeyValue;

  return {
    id,
    apiKey: presented,
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
