import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients, users } from "@/db/schema";
import { withAdminGuardParams } from "@/lib/api-guards";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { parseAdminGrantBody } from "@/lib/billing/admin-grant-body";
import { buildGrantIdempotencyKey } from "@/lib/billing/admin-grant-idempotency";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { getPlatformDefaultApp } from "@/lib/platform-default-app";

async function loadOwnerUser(userId: string) {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

async function resolveGrantClientId(ownerUserId: string): Promise<string | null> {
  const owned = await db
    .select({
      publicClientId: oidcClients.clientId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.ownerId, ownerUserId))
    .orderBy(asc(developerApps.createdAt))
    .limit(1);
  if (owned[0]?.publicClientId) {
    return owned[0].publicClientId;
  }

  const platform = await getPlatformDefaultApp();
  return platform?.clientId ?? null;
}

/**
 * POST /api/v1/admin/billing/owners/[userId]/grants
 * Manual prepaid credit grant (customer-service). Admin-only free mint path.
 */
export const POST = withAdminGuardParams<{ userId: string }>(
  async (request, routeContext, context) => {
    const { userId } = await routeContext.params;
    const owner = await loadOwnerUser(userId);
    if (!owner) {
      return NextResponse.json({ error: "Owner not found" }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = parseAdminGrantBody(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { amountUsdMicros, note, source } = parsed.value;

    const clientId = await resolveGrantClientId(userId);
    if (!clientId) {
      return NextResponse.json(
        {
          error:
            "No app client available for grant context (owner has no apps and platform default app is missing)",
        },
        { status: 503 },
      );
    }

    const correlationId = createCorrelationId();
    const idempotencyKey = buildGrantIdempotencyKey({
      adminId: context.admin.id,
      ownerUserId: userId,
      amountUsdMicros: amountUsdMicros.toString(),
      source,
      note,
    });

    try {
      const result = await grantAllowanceUsdMicros({
        clientId,
        externalUserId: userId,
        amountUsdMicros,
        source,
        idempotencyKey,
      });

      await writeAuditLog({
        clientId,
        actorUserId: context.admin.id,
        action: "admin_credit_grant",
        status: "success",
        correlationId,
        metadata: {
          ownerUserId: userId,
          amountUsdMicros: amountUsdMicros.toString(),
          source,
          note,
          featureKey: result.featureKey,
          idempotencyKey,
        },
      });

      return NextResponse.json({
        ownerUserId: userId,
        clientId,
        source: result.source,
        grantedUsdMicros: result.grantedUsdMicros,
        featureKey: result.featureKey,
        note,
        balance: result.balance,
        idempotencyKey,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Grant failed";
      await writeAuditLog({
        clientId,
        actorUserId: context.admin.id,
        action: "admin_credit_grant",
        status: "error",
        correlationId,
        metadata: {
          ownerUserId: userId,
          amountUsdMicros: amountUsdMicros.toString(),
          source,
          note,
          error: message,
        },
      });
      if (message.includes("OpenMeter not configured")) {
        return NextResponse.json({ error: message }, { status: 503 });
      }
      console.error("[admin/grants] grant failed:", err);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  },
);
