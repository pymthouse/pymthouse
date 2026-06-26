import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { getAdminUser } from "@/lib/admin-auth";
import {
  authenticateAppClient,
  authenticateRequest,
  AuthError,
  hasScope,
  requireAuth,
  type AuthResult,
} from "@/lib/auth";
import type { users } from "@/db/schema";

export type PlatformUser = typeof users.$inferSelect;

export type GuardFailure = { ok: false; response: NextResponse };
export type GuardSuccess<T> = { ok: true; context: T };
export type GuardResult<T> = GuardSuccess<T> | GuardFailure;

export type AdminContext = {
  admin: PlatformUser;
};

export type SessionRoleContext = {
  session: Session;
  userId: string;
  role: string;
};

export type BearerScopeContext = {
  auth: AuthResult;
};

export type AppClientContext = {
  clientId: string;
  appId: string;
  scopes: string;
};

export function jsonUnauthorized(message = "Unauthorized"): GuardFailure {
  return {
    ok: false,
    response: NextResponse.json({ error: message }, { status: 401 }),
  };
}

export function jsonForbidden(message = "Forbidden"): GuardFailure {
  return {
    ok: false,
    response: NextResponse.json({ error: message }, { status: 403 }),
  };
}

export async function requireAdmin(
  request: NextRequest,
): Promise<GuardResult<AdminContext>> {
  const admin = await getAdminUser(request);
  if (!admin) {
    return jsonUnauthorized();
  }
  return { ok: true, context: { admin } };
}

/** Hybrid routes: admin path when present, otherwise fall through to alternate auth. */
export async function resolveAdmin(
  request: NextRequest,
): Promise<PlatformUser | null> {
  const result = await requireAdmin(request);
  return result.ok ? result.context.admin : null;
}

export async function requireSessionRole(
  roles: readonly string[],
): Promise<GuardResult<SessionRoleContext>> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return jsonUnauthorized();
  }

  const sessionUser = session.user as Record<string, unknown>;
  const userId = sessionUser.id;
  const role = sessionUser.role;

  if (typeof userId !== "string" || typeof role !== "string") {
    return jsonUnauthorized();
  }

  if (!roles.includes(role)) {
    return jsonForbidden();
  }

  return { ok: true, context: { session, userId, role } };
}

export async function requireBearerScope(
  request: NextRequest,
  requiredScope: string,
): Promise<GuardResult<BearerScopeContext>> {
  try {
    const auth = await requireAuth(request, requiredScope);
    return { ok: true, context: { auth } };
  } catch (error) {
    if (error instanceof AuthError) {
      return error.status === 403
        ? jsonForbidden(error.message)
        : jsonUnauthorized(error.message);
    }
    throw error;
  }
}

export async function requireAppClient(
  request: Request,
  requiredScope?: string,
): Promise<GuardResult<AppClientContext>> {
  const clientAuth = await authenticateAppClient(request);
  if (!clientAuth) {
    return jsonUnauthorized();
  }

  if (requiredScope && !hasScope(clientAuth.scopes, requiredScope)) {
    return jsonForbidden(`Forbidden: requires '${requiredScope}' scope`);
  }

  return { ok: true, context: clientAuth };
}

export async function resolveBearerAuth(
  request: NextRequest,
): Promise<AuthResult | null> {
  return authenticateRequest(request);
}

type AdminHandler = (
  request: NextRequest,
  context: AdminContext,
) => Promise<NextResponse> | NextResponse;

type AdminParamsHandler<P extends Record<string, string>> = (
  request: NextRequest,
  routeContext: { params: Promise<P> },
  context: AdminContext,
) => Promise<NextResponse> | NextResponse;

type SessionRoleHandler = (
  request: NextRequest,
  context: SessionRoleContext,
) => Promise<NextResponse> | NextResponse;

type SessionRoleParamsHandler<P extends Record<string, string>> = (
  request: NextRequest,
  routeContext: { params: Promise<P> },
  context: SessionRoleContext,
) => Promise<NextResponse> | NextResponse;

export function withAdminGuard(handler: AdminHandler) {
  return async (request: NextRequest) => {
    const guard = await requireAdmin(request);
    if (!guard.ok) {
      return guard.response;
    }
    return handler(request, guard.context);
  };
}

export function withAdminGuardParams<P extends Record<string, string>>(
  handler: AdminParamsHandler<P>,
) {
  return async (
    request: NextRequest,
    routeContext: { params: Promise<P> },
  ) => {
    const guard = await requireAdmin(request);
    if (!guard.ok) {
      return guard.response;
    }
    return handler(request, routeContext, guard.context);
  };
}

export function withSessionRoleGuard(
  roles: readonly string[],
  handler: SessionRoleHandler,
) {
  return async (request: NextRequest) => {
    const guard = await requireSessionRole(roles);
    if (!guard.ok) {
      return guard.response;
    }
    return handler(request, guard.context);
  };
}

export function withSessionRoleGuardParams<P extends Record<string, string>>(
  roles: readonly string[],
  handler: SessionRoleParamsHandler<P>,
) {
  return async (
    request: NextRequest,
    routeContext: { params: Promise<P> },
  ) => {
    const guard = await requireSessionRole(roles);
    if (!guard.ok) {
      return guard.response;
    }
    return handler(request, routeContext, guard.context);
  };
}

export function withSessionAdminGuard(handler: SessionRoleHandler) {
  return withSessionRoleGuard(["admin"], handler);
}

export function withSessionAdminGuardParams<P extends Record<string, string>>(
  handler: SessionRoleParamsHandler<P>,
) {
  return withSessionRoleGuardParams(["admin"], handler);
}
