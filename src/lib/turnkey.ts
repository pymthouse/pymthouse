import { verifySessionJwtSignature } from "@turnkey/crypto";
import { decode as base64urlDecode } from "jose/base64url";
import { db } from "@/db/index";
import { endUsers, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

export type TurnkeySessionClaims = {
  userId: string;
  organizationId: string;
  expirySeconds: number;
  sessionType: string;
};

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Lowercase EVM address for consistent reverse lookup; null if invalid/absent. */
export function normalizeWalletAddress(
  address: string | null | undefined,
): string | null {
  const trimmed = address?.trim();
  if (!trimmed || !EVM_ADDRESS_RE.test(trimmed)) {
    return null;
  }
  return trimmed.toLowerCase();
}

/**
 * Extract the middle segment of a compact JWS as a JSON object.
 * Call only after {@link verifySessionJwtSignature} succeeds — Turnkey session JWTs
 * are not verifiable with `jose.jwtVerify` (custom notarizer digest scheme).
 */
function parseCompactJwsPayloadObject(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length === 5) {
    throw new Error("only compact JWS JWTs are supported");
  }
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("invalid JWT");
  }
  const bytes = base64urlDecode(parts[1]);
  const text = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid JWT claims set");
  }
  return parsed as Record<string, unknown>;
}

/**
 * True when public Turnkey Wallet Kit env is set (client can show embedded wallet UI).
 */
export function isTurnkeyWalletConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() &&
    process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID?.trim()
  );
}

export type VerifyTurnkeySessionJwtOptions = {
  /** Skip TURNKEY_ALLOWED_ORGANIZATION_IDS check (M2M attestation relies on getWalletAccounts). */
  skipOrgAllowlist?: boolean;
};

/**
 * Verify Turnkey session JWT signature and decode claims.
 * Returns null if invalid, expired, or organization not allowed.
 */
export async function verifyTurnkeySessionJwt(
  sessionJwt: string,
  options?: VerifyTurnkeySessionJwtOptions,
): Promise<TurnkeySessionClaims | null> {
  const trimmed = sessionJwt.trim();
  if (!trimmed) return null;

  try {
    const ok = await verifySessionJwtSignature(trimmed);
    if (!ok) return null;

    const decoded = parseCompactJwsPayloadObject(trimmed);
    const exp = decoded.exp;
    const userId = decoded.user_id;
    const organizationId = decoded.organization_id;
    const sessionType = decoded.session_type;

    if (
      typeof exp !== "number" ||
      typeof userId !== "string" ||
      !userId ||
      typeof organizationId !== "string" ||
      !organizationId ||
      typeof sessionType !== "string" ||
      !sessionType
    ) {
      return null;
    }

    if (exp * 1000 < Date.now()) {
      return null;
    }

    if (!options?.skipOrgAllowlist) {
      const allowed = process.env.TURNKEY_ALLOWED_ORGANIZATION_IDS?.trim();
      if (allowed) {
        const ids = new Set(
          allowed.split(",").map((s) => s.trim()).filter(Boolean),
        );
        if (!ids.has(organizationId)) {
          return null;
        }
      }
    }

    return {
      userId,
      organizationId,
      expirySeconds: exp,
      sessionType,
    };
  } catch {
    return null;
  }
}

/**
 * Find or create an end user keyed by Turnkey user id (`user_id` in session JWT).
 */
export async function findOrCreateEndUser(
  turnkeyUserId: string,
  walletAddress?: string,
  turnkeySubOrgId?: string,
): Promise<{ id: string; isNew: boolean }> {
  const normalizedWallet = normalizeWalletAddress(walletAddress);
  const existingRows = await db
    .select()
    .from(endUsers)
    .where(eq(endUsers.turnkeyUserId, turnkeyUserId))
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    const patch: Partial<typeof endUsers.$inferInsert> = {};
    if (normalizedWallet && normalizedWallet !== existing.walletAddress) {
      patch.walletAddress = normalizedWallet;
    }
    if (turnkeySubOrgId && turnkeySubOrgId !== existing.turnkeySubOrgId) {
      patch.turnkeySubOrgId = turnkeySubOrgId;
    }
    if (Object.keys(patch).length > 0) {
      await db.update(endUsers).set(patch).where(eq(endUsers.id, existing.id));
    }
    return { id: existing.id, isNew: false };
  }

  const id = uuidv4();
  await db.insert(endUsers).values({
    id,
    turnkeyUserId,
    walletAddress: normalizedWallet,
    turnkeySubOrgId: turnkeySubOrgId || null,
  });

  return { id, isNew: true };
}

export async function getEndUserByTurnkeyUserId(turnkeyUserId: string) {
  const rows = await db
    .select()
    .from(endUsers)
    .where(eq(endUsers.turnkeyUserId, turnkeyUserId))
    .limit(1);
  return rows[0];
}

/**
 * Find or create a developer user in the users table by Turnkey user id.
 */
export async function findOrCreateDeveloperUser(
  turnkeyUserId: string,
  walletAddress?: string,
  name?: string,
  email?: string,
  turnkeySubOrgId?: string,
): Promise<{ id: string; isNew: boolean }> {
  const normalizedWallet = normalizeWalletAddress(walletAddress);
  const existingRows = await db
    .select()
    .from(users)
    .where(eq(users.turnkeyUserId, turnkeyUserId))
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (normalizedWallet && normalizedWallet !== existing.walletAddress) {
      patch.walletAddress = normalizedWallet;
    }
    if (turnkeySubOrgId && turnkeySubOrgId !== existing.turnkeySubOrgId) {
      patch.turnkeySubOrgId = turnkeySubOrgId;
    }
    if (Object.keys(patch).length > 0) {
      await db.update(users).set(patch).where(eq(users.id, existing.id));
    }
    return { id: existing.id, isNew: false };
  }

  const id = uuidv4();
  const safeEmail = email || `${turnkeyUserId}@turnkey.local`;
  await db.insert(users).values({
    id,
    email: safeEmail,
    name:
      name ||
      (normalizedWallet
        ? `${normalizedWallet.slice(0, 6)}...${normalizedWallet.slice(-4)}`
        : null),
    oauthProvider: "turnkey-wallet",
    oauthSubject: turnkeyUserId,
    role: "developer",
    walletAddress: normalizedWallet,
    turnkeyUserId,
    turnkeySubOrgId: turnkeySubOrgId || null,
  });

  return { id, isNew: true };
}

export async function getEndUserById(endUserId: string) {
  const rows = await db
    .select()
    .from(endUsers)
    .where(eq(endUsers.id, endUserId))
    .limit(1);
  return rows[0];
}
