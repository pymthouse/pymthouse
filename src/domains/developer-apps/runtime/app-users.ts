import type { NextRequest } from "next/server";
import {
  authenticateAppClient,
  authenticateRequestAsync,
  hasScope,
} from "@/domains/identity-access/runtime/request-auth";
import {
  createCorrelationId,
  writeAuditLog,
} from "@/domains/identity-access/runtime/audit";
import { canEditProviderApp, getAuthorizedProviderApp } from "./provider-access";
import { getProviderApp } from "../repo/provider-access";
import {
  deactivateAppUser,
  getAppUserByExternalUserId,
  listAppUsers,
  updateAppUserById,
  upsertAppUser,
} from "../repo/app-users";
import {
  parseCreateAppUserInput,
  parseDeleteAppUserInput,
  parseUpdateAppUserInput,
} from "../service/app-users";

type AppUsersAccess = {
  app: Awaited<ReturnType<typeof getProviderApp>>;
  actorUserId: string | null;
};

async function authorizeAppUsersAccess(
  request: NextRequest,
  clientId: string,
  requiredScope: "users:read" | "users:write",
  requireProviderEdit: boolean,
): Promise<
  | { ok: true; value: NonNullable<AppUsersAccess> }
  | { ok: false; status: 401 | 403; body: { error: string } }
> {
  const app = await getProviderApp(clientId);
  if (!app) {
    return { ok: false, status: 401, body: { error: "Unauthorized" } };
  }

  const providerAuth = await getAuthorizedProviderApp(clientId);
  if (providerAuth) {
    if (requireProviderEdit && !(await canEditProviderApp(providerAuth))) {
      return {
        ok: false,
        status: 403,
        body: { error: "Only platform or app administrators can modify this app." },
      };
    }
    return {
      ok: true,
      value: { app: providerAuth.app, actorUserId: providerAuth.userId },
    };
  }

  const bearer = await authenticateRequestAsync(request);
  if (bearer?.appId === clientId && hasScope(bearer.scopes, requiredScope)) {
    return {
      ok: true,
      value: { app, actorUserId: bearer.userId },
    };
  }

  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const allowed = hasScope(
      clientAuth.scopes,
      requiredScope === "users:read" ? "users:read" : "users:write",
    );
    if (allowed) {
      return {
        ok: true,
        value: { app, actorUserId: null },
      };
    }
  }

  return { ok: false, status: 401, body: { error: "Unauthorized" } };
}

export async function readAppUsers(
  request: NextRequest,
  clientId: string,
): Promise<
  | { ok: true; body: { users: Array<Record<string, unknown>> } }
  | { ok: false; status: 401 | 403; body: { error: string } }
> {
  const access = await authorizeAppUsersAccess(request, clientId, "users:read", false);
  if (!access.ok) {
    return access;
  }

  const users = await listAppUsers(access.value.app.id);
  return {
    ok: true,
    body: {
      users: users.map((user) => ({
        ...user,
        clientId,
      })),
    },
  };
}

export async function createOrUpdateAppUser(
  request: NextRequest,
  clientId: string,
  body: unknown,
): Promise<
  | { ok: true; status: 200 | 201; body: Record<string, unknown> }
  | { ok: false; status: 400 | 401 | 403; body: { error: string } }
> {
  const access = await authorizeAppUsersAccess(request, clientId, "users:write", true);
  if (!access.ok) {
    return access;
  }

  const parsed = parseCreateAppUserInput(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { error: parsed.error } };
  }

  const upserted = await upsertAppUser({
    appId: access.value.app.id,
    externalUserId: parsed.value.externalUserId,
    email: parsed.value.email,
    status: parsed.value.status,
    hasEmail: parsed.value.hasEmail,
    hasStatus: parsed.value.hasStatus,
    createdAt: new Date().toISOString(),
  });

  await writeAuditLog({
    clientId: access.value.app.id,
    actorUserId: access.value.actorUserId,
    action: "app_user_upserted",
    status: "success",
    metadata: { externalUserId: parsed.value.externalUserId },
  });

  return {
    ok: true,
    status: upserted.created ? 201 : 200,
    body: {
      ...upserted.row,
      clientId,
    },
  };
}

export async function updateExistingAppUser(
  request: NextRequest,
  clientId: string,
  body: unknown,
): Promise<
  | { ok: true; body: { success: true } }
  | { ok: false; status: 400 | 401 | 403 | 404; body: { error: string } }
> {
  const access = await authorizeAppUsersAccess(request, clientId, "users:write", true);
  if (!access.ok) {
    return access;
  }

  const parsed = parseUpdateAppUserInput(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { error: parsed.error } };
  }

  const existing = await getAppUserByExternalUserId(
    access.value.app.id,
    parsed.value.externalUserId,
  );
  if (!existing) {
    return { ok: false, status: 404, body: { error: "User not found" } };
  }

  await updateAppUserById(existing.id, {
    email: parsed.value.hasEmail ? parsed.value.email : existing.email,
    status: parsed.value.hasStatus && parsed.value.status ? parsed.value.status : existing.status,
    role: "user",
  });

  await writeAuditLog({
    clientId: access.value.app.id,
    actorUserId: access.value.actorUserId,
    action: "app_user_updated",
    status: "success",
    metadata: { externalUserId: parsed.value.externalUserId },
  });

  return { ok: true, body: { success: true } };
}

export async function deactivateExistingAppUser(
  request: NextRequest,
  clientId: string,
  externalUserIdParam: string | null,
): Promise<
  | { ok: true; body: { success: true; correlation_id: string } }
  | { ok: false; status: 400 | 401 | 403 | 404; body: { error: string } }
> {
  const access = await authorizeAppUsersAccess(request, clientId, "users:write", true);
  if (!access.ok) {
    return access;
  }

  const parsed = parseDeleteAppUserInput(externalUserIdParam);
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { error: parsed.error } };
  }

  const existing = await getAppUserByExternalUserId(access.value.app.id, parsed.value);
  if (!existing) {
    return { ok: false, status: 404, body: { error: "User not found" } };
  }

  await deactivateAppUser(existing.id);

  const correlationId = createCorrelationId();
  await writeAuditLog({
    clientId: access.value.app.id,
    actorUserId: access.value.actorUserId,
    action: "app_user_deactivated",
    status: "success",
    correlationId,
    metadata: { externalUserId: parsed.value },
  });

  return {
    ok: true,
    body: { success: true, correlation_id: correlationId },
  };
}
