import {
  createPublicKey,
  createHash,
  randomBytes,
  verify,
} from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { db } from "@/db/index";
import {
  appUsers,
  developerApps,
  networkAgentChallenges,
  networkAgentRateBuckets,
} from "@/db/schema";
import { createAppUserApiKey } from "@/lib/app-api-keys";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { provisionAppUserBilling } from "@/lib/billing/provision-app-user";
import { createLivepeerPythonSdkToken } from "@/lib/livepeer-python-sdk-token";
import { ensurePlatformDefaultApp } from "@/lib/platform-default-app";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type NetworkAgentRegisterErrorCode =
  | "rate_limited"
  | "invalid_public_key"
  | "invalid_challenge"
  | "invalid_signature"
  | "conflict"
  | "internal";

export class NetworkAgentRegisterError extends Error {
  readonly code: NetworkAgentRegisterErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: NetworkAgentRegisterErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NetworkAgentRegisterError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const RATE_WINDOW_MS = 60_000;
const CHALLENGE_LIMIT_PER_IP = 20;
const CHALLENGE_LIMIT_PER_FINGERPRINT = 5;
const REGISTER_LIMIT_PER_IP = 10;
const REGISTER_LIMIT_PER_FINGERPRINT = 5;
const RATE_BUCKET_PURGE_BATCH = 64;

/** Test-only: clear shared challenge + rate-limit state. */
export async function resetNetworkAgentRegisterStateForTests(): Promise<void> {
  await db.delete(networkAgentChallenges);
  await db.delete(networkAgentRateBuckets);
}

/** Test-only: force a challenge past its expiry. */
export async function expireRegisterChallengeForTests(
  challengeId: string,
): Promise<void> {
  await db
    .update(networkAgentChallenges)
    .set({ expiresAtMs: Date.now() - 1 })
    .where(eq(networkAgentChallenges.challengeId, challengeId));
}

async function purgeExpiredChallenges(nowMs = Date.now()): Promise<void> {
  await db
    .delete(networkAgentChallenges)
    .where(lte(networkAgentChallenges.expiresAtMs, nowMs));
}

async function purgeExpiredRateBuckets(nowMs = Date.now()): Promise<void> {
  await db.execute(sql`
    DELETE FROM network_agent_rate_buckets
    WHERE bucket_key IN (
      SELECT bucket_key FROM network_agent_rate_buckets
      WHERE reset_at_ms <= ${nowMs}
      LIMIT ${RATE_BUCKET_PURGE_BATCH}
    )
  `);
}

async function assertRateLimit(key: string, limit: number): Promise<void> {
  const nowMs = Date.now();
  await purgeExpiredRateBuckets(nowMs);
  const resetAtMs = nowMs + RATE_WINDOW_MS;

  const rows = await db
    .insert(networkAgentRateBuckets)
    .values({
      bucketKey: key,
      count: 1,
      resetAtMs,
    })
    .onConflictDoUpdate({
      target: networkAgentRateBuckets.bucketKey,
      set: {
        count: sql`CASE WHEN ${networkAgentRateBuckets.resetAtMs} <= ${nowMs} THEN 1 ELSE ${networkAgentRateBuckets.count} + 1 END`,
        resetAtMs: sql`CASE WHEN ${networkAgentRateBuckets.resetAtMs} <= ${nowMs} THEN ${resetAtMs} ELSE ${networkAgentRateBuckets.resetAtMs} END`,
      },
    })
    .returning({ count: networkAgentRateBuckets.count });

  const count = rows[0]?.count ?? 0;
  if (count > limit) {
    throw new NetworkAgentRegisterError(
      "rate_limited",
      "Too many requests. Try again shortly.",
      429,
    );
  }
}

function decodeBytes(
  raw: string,
  label: string,
  code: NetworkAgentRegisterErrorCode = "invalid_public_key",
): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new NetworkAgentRegisterError(code, `${label} is required`, 400);
  }

  if (/^(0x)?[0-9a-fA-F]+$/.test(trimmed)) {
    const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed.slice(2)
      : trimmed;
    if (hex.length % 2 !== 0) {
      throw new NetworkAgentRegisterError(
        code,
        `${label} hex length must be even`,
        400,
      );
    }
    return Buffer.from(hex, "hex");
  }

  try {
    const b64 = Buffer.from(trimmed, "base64");
    if (b64.length > 0) {
      return b64;
    }
  } catch {
    // fall through
  }

  try {
    const b64url = Buffer.from(trimmed, "base64url");
    if (b64url.length > 0) {
      return b64url;
    }
  } catch {
    // fall through
  }

  throw new NetworkAgentRegisterError(
    code,
    `${label} must be hex or base64`,
    400,
  );
}

/** Normalize an Ed25519 public key to raw 32-byte form. */
export function normalizeEd25519PublicKey(publicKey: string): Buffer {
  const bytes = decodeBytes(publicKey, "publicKey", "invalid_public_key");
  if (bytes.length === 32) {
    return bytes;
  }
  if (bytes.length === 44 && bytes.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    return bytes.subarray(12);
  }
  throw new NetworkAgentRegisterError(
    "invalid_public_key",
    "publicKey must be a 32-byte Ed25519 key (raw or SPKI)",
    400,
  );
}

/** Stable fingerprint: first 32 hex chars of sha256(raw public key). */
export function publicKeyFingerprint(publicKey: string | Buffer): string {
  const raw = typeof publicKey === "string"
    ? normalizeEd25519PublicKey(publicKey)
    : publicKey;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** Stable app_users external subject for an agent public key. */
export function agentExternalUserId(publicKey: string | Buffer): string {
  return `agent:${publicKeyFingerprint(publicKey)}`;
}

function ed25519PublicKeyObject(raw: Buffer) {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({
    key: der,
    format: "der",
    type: "spki",
  });
}

export async function verifyEd25519Challenge(input: {
  publicKey: string;
  challengeId: string;
  signature: string;
}): Promise<{ fingerprint: string; nonce: string; externalUserId: string }> {
  const rawPk = normalizeEd25519PublicKey(input.publicKey);
  const fingerprint = publicKeyFingerprint(rawPk);
  const challengeId = input.challengeId.trim();
  const nowMs = Date.now();

  const rows = await db
    .select()
    .from(networkAgentChallenges)
    .where(eq(networkAgentChallenges.challengeId, challengeId))
    .limit(1);
  const record = rows[0];
  if (!record) {
    await purgeExpiredChallenges(nowMs);
    throw new NetworkAgentRegisterError(
      "invalid_challenge",
      "Unknown or already-used challenge",
      400,
    );
  }
  if (record.expiresAtMs <= nowMs) {
    await db
      .delete(networkAgentChallenges)
      .where(eq(networkAgentChallenges.challengeId, challengeId));
    await purgeExpiredChallenges(nowMs);
    throw new NetworkAgentRegisterError(
      "invalid_challenge",
      "Challenge expired",
      400,
    );
  }
  if (record.fingerprint !== fingerprint) {
    throw new NetworkAgentRegisterError(
      "invalid_challenge",
      "Challenge was issued for a different public key",
      400,
    );
  }

  const sigBytes = decodeBytes(input.signature, "signature", "invalid_signature");
  if (sigBytes.length !== 64) {
    throw new NetworkAgentRegisterError(
      "invalid_signature",
      "signature must be 64 bytes",
      401,
    );
  }

  const ok = verify(
    null,
    Buffer.from(record.nonce, "utf8"),
    ed25519PublicKeyObject(rawPk),
    sigBytes,
  );
  if (!ok) {
    throw new NetworkAgentRegisterError(
      "invalid_signature",
      "Ed25519 signature verification failed",
      401,
    );
  }

  // Consume challenge (one-time).
  const consumed = await db
    .delete(networkAgentChallenges)
    .where(eq(networkAgentChallenges.challengeId, challengeId))
    .returning({ challengeId: networkAgentChallenges.challengeId });
  if (consumed.length === 0) {
    throw new NetworkAgentRegisterError(
      "invalid_challenge",
      "Unknown or already-used challenge",
      400,
    );
  }

  return {
    fingerprint,
    nonce: record.nonce,
    externalUserId: agentExternalUserId(rawPk),
  };
}

export async function createRegisterChallenge(input: {
  publicKey: string;
  clientIp?: string;
}): Promise<{
  challengeId: string;
  nonce: string;
  expiresAt: string;
  alg: "Ed25519";
  fingerprint: string;
}> {
  await purgeExpiredChallenges();

  const rawPk = normalizeEd25519PublicKey(input.publicKey);
  const fingerprint = publicKeyFingerprint(rawPk);
  const ip = input.clientIp?.trim() || "unknown";

  // Skip the IP bucket when the client IP is unknown so all non-Vercel / headerless
  // callers do not share one global limiter (DoS). Fingerprint limits still apply.
  if (ip !== "unknown") {
    await assertRateLimit(`challenge:ip:${ip}`, CHALLENGE_LIMIT_PER_IP);
  }
  await assertRateLimit(
    `challenge:fp:${fingerprint}`,
    CHALLENGE_LIMIT_PER_FINGERPRINT,
  );

  await db
    .delete(networkAgentChallenges)
    .where(eq(networkAgentChallenges.fingerprint, fingerprint));

  const challengeId = uuidv4();
  const nonce = randomBytes(32).toString("base64url");
  const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;
  await db.insert(networkAgentChallenges).values({
    challengeId,
    fingerprint,
    nonce,
    expiresAtMs,
  });

  return {
    challengeId,
    nonce,
    expiresAt: new Date(expiresAtMs).toISOString(),
    alg: "Ed25519",
    fingerprint,
  };
}

export type NetworkAgentRegisterResult = {
  clientId: string;
  externalUserId: string;
  apiKey: string;
  keyId: string;
  prefix: string;
  suffix: string;
  label: string | null;
  sdkToken: string | null;
  correlationId: string;
};

async function writeRegisterConflictAudit(input: {
  clientId: string;
  correlationId: string;
  externalUserId: string;
  fingerprint: string;
}): Promise<never> {
  await writeAuditLog({
    clientId: input.clientId,
    action: "network_agent_register_conflict",
    status: "conflict",
    correlationId: input.correlationId,
    metadata: {
      externalUserId: input.externalUserId,
      fingerprint: input.fingerprint,
    },
  });
  throw new NetworkAgentRegisterError(
    "conflict",
    "Agent already registered for this public key. Reuse the previously issued API key.",
    409,
    { clientId: input.clientId, externalUserId: input.externalUserId },
  );
}

/**
 * Prove possession of an Ed25519 key and mint a default-app network API key.
 * Does not create a platform `users` / Turnkey account.
 */
export async function registerNetworkAgent(input: {
  publicKey: string;
  challengeId: string;
  signature: string;
  label?: string | null;
  clientIp?: string;
}): Promise<NetworkAgentRegisterResult> {
  const ip = input.clientIp?.trim() || "unknown";
  const rawPk = normalizeEd25519PublicKey(input.publicKey);
  const fingerprint = publicKeyFingerprint(rawPk);

  if (ip !== "unknown") {
    await assertRateLimit(`register:ip:${ip}`, REGISTER_LIMIT_PER_IP);
  }
  await assertRateLimit(
    `register:fp:${fingerprint}`,
    REGISTER_LIMIT_PER_FINGERPRINT,
  );

  const { clientId } = await ensurePlatformDefaultApp();
  const externalUserId = agentExternalUserId(rawPk);
  const correlationId = createCorrelationId();

  const appRows = await db
    .select({ id: developerApps.id })
    .from(developerApps)
    .where(eq(developerApps.id, clientId))
    .limit(1);
  const developerAppId = appRows[0]?.id;
  if (!developerAppId) {
    throw new NetworkAgentRegisterError(
      "internal",
      "Platform default app is missing",
      500,
    );
  }

  // Fail closed on conflict before burning the one-time challenge.
  const existing = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, developerAppId),
        eq(appUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await writeRegisterConflictAudit({
      clientId,
      correlationId,
      externalUserId,
      fingerprint,
    });
  }

  await verifyEd25519Challenge({
    publicKey: input.publicKey,
    challengeId: input.challengeId,
    signature: input.signature,
  });

  const now = new Date().toISOString();
  const newUser = {
    id: uuidv4(),
    clientId: developerAppId,
    externalUserId,
    email: null,
    status: "active",
    role: "user",
    createdAt: now,
  };

  const inserted = await db
    .insert(appUsers)
    .values(newUser)
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    await writeRegisterConflictAudit({
      clientId,
      correlationId,
      externalUserId,
      fingerprint,
    });
  }

  const appUser = inserted[0]!;

  // Mint the API key before billing so a mint failure only rolls back app_users
  // and never leaves orphaned OpenMeter / end-user billing state.
  let created: Awaited<ReturnType<typeof createAppUserApiKey>>;
  try {
    created = await createAppUserApiKey({
      developerAppId,
      appUserId: appUser.id,
      publicClientId: clientId,
      label: input.label?.trim() || "agent-network-key",
    });
  } catch (err) {
    await db.delete(appUsers).where(eq(appUsers.id, appUser.id));
    console.error("Network agent API key mint failed; rolled back app_user:", err);
    throw new NetworkAgentRegisterError(
      "internal",
      "Failed to mint API key for network agent",
      500,
    );
  }

  try {
    await provisionAppUserBilling({
      clientId: developerAppId,
      externalUserId,
    });
  } catch (err) {
    console.error("Network agent billing provision failed:", err);
  }

  await writeAuditLog({
    clientId,
    action: "network_agent_registered",
    status: "ok",
    correlationId,
    metadata: {
      externalUserId,
      fingerprint,
      keyId: created.id,
    },
  });

  let sdkToken: string | null = null;
  try {
    sdkToken = createLivepeerPythonSdkToken({
      apiKey: created.apiKey,
      signer: getClientSignerApiUrl(clientId),
    });
  } catch {
    sdkToken = null;
  }

  return {
    clientId,
    externalUserId,
    apiKey: created.apiKey,
    keyId: created.id,
    prefix: created.prefix,
    suffix: created.suffix,
    label: created.label,
    sdkToken,
    correlationId,
  };
}

export { clientIpFromRequest } from "@/lib/client-ip";
