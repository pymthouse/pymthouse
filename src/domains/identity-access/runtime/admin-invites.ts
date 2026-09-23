import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  claimAdminInviteAndPromoteUser,
  createAdminInvite,
  listOpenAdminInvites,
} from "../repo/admin-invites";

export async function issueAdminInvite(createdBy: string) {
  const code = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await createAdminInvite({
    id: uuidv4(),
    code,
    createdBy,
    expiresAt,
  });
  return { code, expiresAt };
}

export async function readOpenAdminInvites() {
  return listOpenAdminInvites(new Date().toISOString());
}

export async function redeemAdminInvite(code: string, userId: string) {
  const result = await claimAdminInviteAndPromoteUser({
    code,
    userId,
    now: new Date().toISOString(),
  });
  if (!result.ok) {
    return {
      ok: false as const,
      status: 400,
      body: { error: "Invalid or expired invite code" },
    };
  }
  return {
    ok: true as const,
    status: 200,
    body: { success: true, role: "admin" },
  };
}
