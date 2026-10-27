import {
  createAppAdminMembership,
  deleteAppAdminMembership,
  getAppAdminMembership,
  getUserById,
  listAppAdminMemberships,
} from "../repo/app-admins";
import { parseCreateAppAdminInput, parseDeleteAppAdminInput } from "../service/app-admins";

export async function readAppAdmins(clientId: string, appId: string) {
  const { memberships, adminUsers } = await listAppAdminMemberships(appId);
  return memberships.map((membership) => ({
    ...membership,
    clientId,
    user: adminUsers.find((user) => user.id === membership.userId) || null,
  }));
}

export async function addAppAdmin(
  clientId: string,
  appId: string,
  body: unknown,
): Promise<
  | { ok: true; status: 200 | 201; body: Record<string, unknown> }
  | { ok: false; status: 400 | 404; error: string }
> {
  const parsed = parseCreateAppAdminInput(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }

  const user = await getUserById(parsed.value.userId);
  if (!user) {
    return { ok: false, status: 404, error: "User not found" };
  }

  const existing = await getAppAdminMembership(appId, parsed.value.userId);
  if (existing) {
    return { ok: true, status: 200, body: existing };
  }

  const membership = await createAppAdminMembership(appId, parsed.value.userId, parsed.value.role);
  return { ok: true, status: 201, body: { ...membership, clientId } };
}

export async function removeAppAdmin(
  appId: string,
  userIdParam: string | null,
): Promise<{ ok: true } | { ok: false; status: 400; error: string }> {
  const parsed = parseDeleteAppAdminInput(userIdParam);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }

  await deleteAppAdminMembership(appId, parsed.value);
  return { ok: true };
}
