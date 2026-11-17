import { v4 as uuidv4 } from "uuid";
import { verifyTurnkeySessionJwt } from "@/domains/identity-access/runtime/turnkey-users";
import {
  addCredits,
  createEndUser,
  deductCredits,
  getEndUserById,
  getEndUserByTurnkeyUserId,
  listEndUsers,
  updateEndUserWalletAddress,
} from "../repo/end-users";
import { createAppEndUser, getAppEndUser } from "../repo/app-end-users";

export async function listAdminEndUsers() {
  return listEndUsers();
}

export async function getEndUserForTurnkeySession(sessionJwt: string) {
  const claims = await verifyTurnkeySessionJwt(sessionJwt);
  if (!claims) {
    return { ok: false as const, status: 401, body: { error: "Invalid Turnkey session" } };
  }

  const endUser = await getEndUserByTurnkeyUserId(claims.userId);
  if (!endUser) {
    return { ok: false as const, status: 404, body: { error: "End user not found" } };
  }

  return { ok: true as const, status: 200, body: { endUser } };
}

export async function createAdminEndUser(body: Record<string, unknown>) {
  const id = uuidv4();
  await createEndUser({
    id,
    turnkeyUserId:
      typeof body.turnkeyUserId === "string" && body.turnkeyUserId.trim()
        ? body.turnkeyUserId.trim()
        : null,
    walletAddress:
      typeof body.walletAddress === "string" && body.walletAddress.trim()
        ? body.walletAddress.trim()
        : null,
    creditBalanceWei:
      typeof body.creditBalanceWei === "string" && body.creditBalanceWei.trim()
        ? body.creditBalanceWei.trim()
        : "0",
  });

  const endUser = await getEndUserById(id);
  return { status: 201, body: { endUser } };
}

export async function findOrCreateEndUserFromTurnkeySession(
  sessionJwt: string,
  walletAddress?: string,
) {
  const claims = await verifyTurnkeySessionJwt(sessionJwt);
  if (!claims) {
    return { ok: false as const, status: 401, body: { error: "Invalid Turnkey session" } };
  }

  const existing = await getEndUserByTurnkeyUserId(claims.userId);
  if (existing) {
    if (walletAddress && walletAddress !== existing.walletAddress) {
      await updateEndUserWalletAddress(existing.id, walletAddress);
    }
    const endUser = await getEndUserById(existing.id);
    return { ok: true as const, status: 200, body: { endUser, isNew: false } };
  }

  const id = uuidv4();
  await createEndUser({
    id,
    turnkeyUserId: claims.userId,
    walletAddress: walletAddress || null,
    creditBalanceWei: "0",
  });
  const endUser = await getEndUserById(id);
  return { ok: true as const, status: 201, body: { endUser, isNew: true } };
}

export async function updateEndUserCredits(params: {
  endUserId: string;
  action: string;
  amountWei: string;
}) {
  if (!params.endUserId || !params.action || !params.amountWei) {
    return {
      ok: false as const,
      status: 400,
      body: { error: "id, action, and amountWei are required" },
    };
  }

  if (!/^\d+$/.test(String(params.amountWei))) {
    return {
      ok: false as const,
      status: 400,
      body: { error: "amountWei must be a non-negative integer string" },
    };
  }

  const amount = BigInt(params.amountWei);
  if (params.action === "add_credits") {
    await addCredits(params.endUserId, amount);
  } else if (params.action === "deduct_credits") {
    const success = await deductCredits(params.endUserId, amount);
    if (!success) {
      return { ok: false as const, status: 400, body: { error: "Insufficient balance" } };
    }
  } else {
    return {
      ok: false as const,
      status: 400,
      body: { error: "action must be 'add_credits' or 'deduct_credits'" },
    };
  }

  const endUser = await getEndUserById(params.endUserId);
  return { ok: true as const, status: 200, body: { endUser } };
}

export { addCredits, deductCredits };

export async function findOrCreateAppEndUser(
  appIdOrParams: string | { appId: string; externalUserId: string },
  externalUserIdArg?: string,
) {
  const params =
    typeof appIdOrParams === "string"
      ? { appId: appIdOrParams, externalUserId: externalUserIdArg || "" }
      : appIdOrParams;

  const existing = await getAppEndUser(params.appId, params.externalUserId);
  if (existing) {
    return { id: existing.id, isNew: false };
  }

  const id = uuidv4();
  try {
    await createAppEndUser({
      id,
      appId: params.appId,
      externalUserId: params.externalUserId,
    });
    return { id, isNew: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isUniqueViolation =
      msg.includes("unique") ||
      msg.includes("duplicate") ||
      (err as Record<string, unknown>).code === "23505";
    if (isUniqueViolation) {
      const retry = await getAppEndUser(params.appId, params.externalUserId);
      if (retry) return { id: retry.id, isNew: false };
    }
    throw err;
  }
}
