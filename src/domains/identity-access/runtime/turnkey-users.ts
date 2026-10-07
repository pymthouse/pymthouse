import { verifySessionJwtSignature } from "@turnkey/crypto";
import { decode as base64urlDecode } from "jose/base64url";
import { v4 as uuidv4 } from "uuid";
import {
  createDeveloperUser,
  getUserByTurnkeyUserId,
  updateUserWalletAddress,
} from "../repo/users";

export type TurnkeySessionClaims = {
  userId: string;
  organizationId: string;
  expirySeconds: number;
  sessionType: string;
};

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

export function isTurnkeyWalletConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() &&
    process.env.NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID?.trim()
  );
}

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
      const ids = new Set(allowed.split(",").map((s) => s.trim()).filter(Boolean));
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

export async function findOrCreateDeveloperUser(
  turnkeyUserId: string,
  walletAddress?: string,
  name?: string,
  email?: string,
): Promise<{ id: string; isNew: boolean }> {
  const existing = await getUserByTurnkeyUserId(turnkeyUserId);

  if (existing) {
    if (walletAddress && walletAddress !== existing.walletAddress) {
      await updateUserWalletAddress(existing.id, walletAddress);
    }
    return { id: existing.id, isNew: false };
  }

  const id = uuidv4();
  const safeEmail = email || `${turnkeyUserId}@turnkey.local`;
  await createDeveloperUser({
    id,
    turnkeyUserId,
    email: safeEmail,
    name:
      name ||
      (walletAddress
        ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
        : null),
    walletAddress: walletAddress || null,
  });

  return { id, isNew: true };
}
