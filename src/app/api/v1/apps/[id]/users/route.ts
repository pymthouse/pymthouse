import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { authenticateAppClient, authenticateRequestAsync, hasScope } from "@/lib/auth";
import { db } from "@/db/index";
import { appUsers } from "@/db/schema";
import {
  canEditProviderApp,
  getProviderApp,
  getAuthorizedProviderApp,
  appEditForbiddenResponse,
} from "@/lib/provider-apps";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { runActivationGate } from "@/lib/activation/app-activation";
import { activationErrorResponse } from "@/lib/activation/problem";
import { parseAppUserStatus, type AppUserStatus } from "@/lib/billing/app-user-status";
import { provisionAppUserBilling } from "@/lib/billing/provision-app-user";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

async function canAccessUsers(request: NextRequest, clientId: string, requiredScope: string) {
  const app = await getProviderApp(clientId);
  if (!app) {
    return null;
  }

  const providerAuth = await getAuthorizedProviderApp(clientId);
  if (providerAuth) {
    return { app: providerAuth.app, actorUserId: providerAuth.userId, clientId: providerAuth.app.id };
  }

  const bearer = await authenticateRequestAsync(request);
  if (bearer?.appId === clientId && hasScope(bearer.scopes, requiredScope)) {
    return { app, actorUserId: bearer.userId, clientId: app.id };
  }

  const clientAuth = await authenticateAppClient(request);
  if (clientAuth?.appId === clientId) {
    const required = requiredScope === "users:read" ? "users:read" : "users:write";
    const allowed = hasScope(clientAuth.scopes, required);
    if (allowed) {
      return { app, actorUserId: null, clientId: app.id };
    }
  }

  return null;
}

async function getAppUserStatus(
  appId: string,
  externalUserId: string,
): Promise<string | null> {
  const rows = await db
    .select({ status: appUsers.status })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, appId),
        eq(appUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return rows[0]?.status ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const access = await canAccessUsers(request, clientId, "users:read");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const users = await db.select().from(appUsers).where(eq(appUsers.clientId, access.app.id));
  return NextResponse.json({
    users: users.map((user) => ({
      ...user,
      clientId,
    })),
  });
}

function parseUpsertUserBody(body: Record<string, unknown>): {
  ok: true;
  externalUserId: string;
  hasEmail: boolean;
  hasStatus: boolean;
  email: string | null;
  status: AppUserStatus;
} | { ok: false; response: NextResponse } {
  const externalUserId =
    typeof body.externalUserId === "string" ? body.externalUserId.trim() : "";
  if (!externalUserId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "externalUserId is required" },
        { status: 400 },
      ),
    };
  }
  const hasEmail = typeof body.email === "string";
  const hasStatus = "status" in body && body.status !== undefined;
  let status: AppUserStatus = "active";
  if (hasStatus) {
    const parsedStatus = parseAppUserStatus(body.status);
    if (!parsedStatus.ok) {
      return {
        ok: false,
        response: NextResponse.json({ error: parsedStatus.error }, { status: 400 }),
      };
    }
    status = parsedStatus.status;
  }
  return {
    ok: true,
    externalUserId,
    hasEmail,
    hasStatus,
    email: hasEmail ? (body.email as string).trim() : null,
    status,
  };
}

async function upsertAppUserRow(input: {
  appId: string;
  externalUserId: string;
  email: string | null;
  status: AppUserStatus;
  hasEmail: boolean;
  hasStatus: boolean;
}) {
  const newUser = {
    id: uuidv4(),
    clientId: input.appId,
    externalUserId: input.externalUserId,
    email: input.email,
    status: input.status,
    role: "user" as const,
    createdAt: new Date().toISOString(),
  };
  const updateSet: { email?: string | null; status?: AppUserStatus; role: "user" } = {
    role: "user",
  };
  if (input.hasEmail) updateSet.email = input.email;
  if (input.hasStatus) updateSet.status = input.status;

  const upserted = await db
    .insert(appUsers)
    .values(newUser)
    .onConflictDoUpdate({
      target: [appUsers.clientId, appUsers.externalUserId],
      set: updateSet,
    })
    .returning();
  const row = upserted[0] ?? newUser;
  return { row, isNew: row.id === newUser.id };
}

async function provisionAfterUpsert(
  appId: string,
  externalUserId: string,
): Promise<NextResponse | null> {
  try {
    await provisionAppUserBilling({ clientId: appId, externalUserId });
    return null;
  } catch (err) {
    const problem = activationErrorResponse(err);
    if (problem) return problem;
    console.error(
      "provisionAppUserBilling failed on user upsert:",
      sanitizeForLog(err instanceof Error ? err.message : err),
    );
    return null;
  }
}

async function runProvisionGate(
  appId: string,
  externalUserId: string,
  activating?: boolean,
): Promise<NextResponse | null> {
  try {
    await runActivationGate("provision", appId, {
      externalUserId,
      activating,
    });
    return null;
  } catch (err) {
    const problem = activationErrorResponse(err);
    if (problem) return problem;
    throw err;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const providerAuth = await getAuthorizedProviderApp(clientId);
  if (providerAuth && !(await canEditProviderApp(providerAuth))) {
    return appEditForbiddenResponse();
  }

  const access = await canAccessUsers(request, clientId, "users:write");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseUpsertUserBody(body);
  if (!parsed.ok) {
    return parsed.response;
  }

  const previousStatus = await getAppUserStatus(
    access.app.id,
    parsed.externalUserId,
  );
  const nextStatus: AppUserStatus = parsed.hasStatus
    ? parsed.status
    : previousStatus === "inactive"
      ? "inactive"
      : "active";
  // New rows and inactive→active transitions consume a cap slot.
  const activating =
    nextStatus === "active" && previousStatus !== "active";

  if (activating) {
    const gateProblem = await runProvisionGate(
      access.app.id,
      parsed.externalUserId,
      previousStatus != null,
    );
    if (gateProblem) {
      return gateProblem;
    }
  }

  const { row, isNew } = await upsertAppUserRow({
    appId: access.app.id,
    externalUserId: parsed.externalUserId,
    email: parsed.email,
    status: nextStatus,
    hasEmail: parsed.hasEmail,
    // Persist the resolved next status so create defaults to active and
    // reactivate paths write explicitly without requiring a status field.
    hasStatus: parsed.hasStatus || activating || previousStatus == null,
  });

  const provisionProblem = await provisionAfterUpsert(
    access.app.id,
    parsed.externalUserId,
  );
  if (provisionProblem) {
    return provisionProblem;
  }

  await writeAuditLog({
    clientId: access.app.id,
    actorUserId: access.actorUserId,
    action: "app_user_upserted",
    status: "success",
    metadata: { externalUserId: parsed.externalUserId },
  });

  return NextResponse.json(
    {
      ...row,
      clientId,
    },
    { status: isNew ? 201 : 200 },
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const providerAuthPut = await getAuthorizedProviderApp(clientId);
  if (providerAuthPut && !(await canEditProviderApp(providerAuthPut))) {
    return appEditForbiddenResponse();
  }

  const access = await canAccessUsers(request, clientId, "users:write");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const externalUserId =
    typeof body.externalUserId === "string" ? body.externalUserId.trim() : "";
  if (!externalUserId) {
    return NextResponse.json({ error: "externalUserId is required" }, { status: 400 });
  }

  const existingPutRows = await db
    .select()
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, access.app.id),
        eq(appUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  const existing = existingPutRows[0];

  if (!existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  let nextStatus = existing.status;
  if ("status" in body && body.status !== undefined) {
    const parsedStatus = parseAppUserStatus(body.status);
    if (!parsedStatus.ok) {
      return NextResponse.json({ error: parsedStatus.error }, { status: 400 });
    }
    nextStatus = parsedStatus.status;
  }

  if (nextStatus === "active" && existing.status !== "active") {
    const gateProblem = await runProvisionGate(
      access.app.id,
      externalUserId,
      true,
    );
    if (gateProblem) {
      return gateProblem;
    }
  }

  await db
    .update(appUsers)
    .set({
      email: typeof body.email === "string" ? body.email.trim() : existing.email,
      status: nextStatus,
      role: "user",
    })
    .where(eq(appUsers.id, existing.id));

  await writeAuditLog({
    clientId: access.app.id,
    actorUserId: access.actorUserId,
    action: "app_user_updated",
    status: "success",
    metadata: { externalUserId },
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const providerAuthDel = await getAuthorizedProviderApp(clientId);
  if (providerAuthDel && !(await canEditProviderApp(providerAuthDel))) {
    return appEditForbiddenResponse();
  }

  const access = await canAccessUsers(request, clientId, "users:write");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const externalUserId = searchParams.get("externalUserId");
  if (!externalUserId) {
    return NextResponse.json({ error: "externalUserId is required" }, { status: 400 });
  }

  const existingDelRows = await db
    .select()
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, access.app.id),
        eq(appUsers.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  const existing = existingDelRows[0];

  if (!existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await db.update(appUsers).set({ status: "inactive" }).where(eq(appUsers.id, existing.id));

  const correlationId = createCorrelationId();
  await writeAuditLog({
    clientId: access.app.id,
    actorUserId: access.actorUserId,
    action: "app_user_deactivated",
    status: "success",
    correlationId,
    metadata: { externalUserId },
  });

  return NextResponse.json({
    success: true,
    status: "inactive",
    correlation_id: correlationId,
  });
}
