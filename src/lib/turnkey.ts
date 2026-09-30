import { verifySessionJwtSignature } from "@turnkey/crypto";
import { decode as base64urlDecode } from "jose/base64url";
import { db } from "@/db/index";
import { endUsers, users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getTurnkeyServerApiClient } from "@/lib/onramp/turnkey-client";
import { v4 as uuidv4 } from "uuid";

export type TurnkeySessionClaims = {
  userId: string;
  organizationId: string;
  expirySeconds: number;
  sessionType: string;
};

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

export {
  getTurnkeyWalletConfigId,
  isTurnkeyWalletConfigured,
} from "@/lib/turnkey-wallet-config";

/**
 * Verify Turnkey session JWT signature and decode claims.
 * Returns null if invalid, expired, or organization not allowed.
 */
export async function verifyTurnkeySessionJwt(
  sessionJwt: string,
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

    const allowed = process.env.TURNKEY_ALLOWED_ORGANIZATION_IDS?.trim();
    if (allowed) {
      const ids = new Set(
        allowed.split(",").map((s) => s.trim()).filter(Boolean),
      );
      if (!ids.has(organizationId)) {
        return null;
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
): Promise<{ id: string; isNew: boolean }> {
  const existingRows = await db
    .select()
    .from(endUsers)
    .where(eq(endUsers.turnkeyUserId, turnkeyUserId))
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    if (walletAddress && walletAddress !== existing.walletAddress) {
      await db
        .update(endUsers)
        .set({ walletAddress })
        .where(eq(endUsers.id, existing.id));
    }
    return { id: existing.id, isNew: false };
  }

  const id = uuidv4();
  await db.insert(endUsers).values({
    id,
    turnkeyUserId,
    walletAddress: walletAddress || null,
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

export type TurnkeyIdentityClient = {
  getUsers(input: { organizationId: string }): Promise<{
    users?: Array<{
      userId: string;
      userName?: string;
      userEmail?: string;
    }>;
  }>;
  getWallets(input: { organizationId: string }): Promise<{
    wallets?: Array<{ accounts?: Array<{ address?: string }> }>;
  }>;
};

export function isPlaceholderTurnkeyEmail(
  email: string | null | undefined,
  turnkeyUserId: string,
): boolean {
  if (!email?.trim()) return true;
  return (
    email.trim().toLowerCase() ===
    `${turnkeyUserId.trim().toLowerCase()}@turnkey.local`
  );
}

export function normalizeTurnkeyEmail(
  email: string | null | undefined,
): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || undefined;
}

export function firstEvmAddressFromTurnkeyWallets(
  wallets: Array<{ accounts?: Array<{ address?: string }> }>,
): string | undefined {
  for (const wallet of wallets) {
    for (const account of wallet.accounts ?? []) {
      const addr = account.address?.trim();
      if (addr?.startsWith("0x")) return addr;
    }
  }
  return undefined;
}

export function developerUserUpdates(input: {
  existing: {
    email: string | null;
    name: string | null;
    walletAddress: string | null;
    turnkeyUserId: string | null;
  };
  email?: string;
  name?: string;
  walletAddress?: string;
}): { email?: string; name?: string; walletAddress?: string } | null {
  const updates: {
    email?: string;
    name?: string;
    walletAddress?: string;
  } = {};
  if (
    input.email &&
    isPlaceholderTurnkeyEmail(
      input.existing.email,
      input.existing.turnkeyUserId ?? "",
    )
  ) {
    updates.email = input.email;
  }
  if (input.name && !input.existing.name) {
    updates.name = input.name;
  }
  if (
    input.walletAddress &&
    input.walletAddress !== input.existing.walletAddress
  ) {
    updates.walletAddress = input.walletAddress;
  }
  return Object.keys(updates).length > 0 ? updates : null;
}

/**
 * Read email / name / wallet from the parent org's view of the sub-org.
 * Never trust client-supplied identity fields for this.
 */
export async function resolveTurnkeyDeveloperIdentity(
  claims: TurnkeySessionClaims,
  deps?: { getClient(): TurnkeyIdentityClient },
): Promise<{
  email?: string;
  name?: string;
  walletAddress?: string;
}> {
  try {
    const client =
      deps?.getClient() ??
      (getTurnkeyServerApiClient() as TurnkeyIdentityClient);
    const [usersResult, walletsResult] = await Promise.all([
      client.getUsers({ organizationId: claims.organizationId }),
      client.getWallets({ organizationId: claims.organizationId }),
    ]);
    const tkUser = (usersResult.users ?? []).find(
      (u) => u.userId === claims.userId,
    );
    return {
      email: normalizeTurnkeyEmail(tkUser?.userEmail),
      name: tkUser?.userName?.trim() || undefined,
      walletAddress: firstEvmAddressFromTurnkeyWallets(
        walletsResult.wallets ?? [],
      ),
    };
  } catch (err) {
    console.warn(
      "Failed to resolve Turnkey user profile from parent org",
      err,
    );
    return {};
  }
}

/**
 * Find or create a developer user in the users table by Turnkey user id.
 */
export async function findOrCreateDeveloperUser(input: {
  turnkeyUserId: string;
  walletAddress?: string;
  name?: string;
  email?: string;
  organizationId?: string;
}): Promise<{ id: string; isNew: boolean }> {
  const email = normalizeTurnkeyEmail(input.email);
  const existingRows = await db
    .select()
    .from(users)
    .where(eq(users.turnkeyUserId, input.turnkeyUserId))
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    const updates = developerUserUpdates({
      existing,
      email,
      name: input.name,
      walletAddress: input.walletAddress,
    });
    if (updates) {
      await db.update(users).set(updates).where(eq(users.id, existing.id));
    }
    return { id: existing.id, isNew: false };
  }

  if (email) {
    const collisions = await db
      .select({
        id: users.id,
        turnkeyUserId: users.turnkeyUserId,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(5);
    if (collisions.length > 0) {
      console.warn(
        "Turnkey identity collision: new turnkey_user_id for an existing email",
        {
          email,
          existingUserIds: collisions.map((row) => row.id),
          existingTurnkeyUserIds: collisions.map((row) => row.turnkeyUserId),
          newTurnkeyUserId: input.turnkeyUserId,
          newOrganizationId: input.organizationId,
        },
      );
    }
  }

  const id = uuidv4();
  await db.insert(users).values({
    id,
    email: email ?? null,
    name:
      input.name ||
      (input.walletAddress
        ? `${input.walletAddress.slice(0, 6)}...${input.walletAddress.slice(-4)}`
        : null),
    oauthProvider: "turnkey-wallet",
    oauthSubject: input.turnkeyUserId,
    role: "developer",
    walletAddress: input.walletAddress || null,
    turnkeyUserId: input.turnkeyUserId,
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
