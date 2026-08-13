import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients, users } from "@/db/schema";
import { withAdminGuardParams } from "@/lib/api-guards";
import { createCorrelationId, writeAuditLog } from "@/lib/audit";
import { buildGrantIdempotencyKey } from "@/lib/billing/admin-grant-idempotency";
import type { GrantSource } from "@/lib/billing/types";
import { grantAllowanceUsdMicros } from "@/lib/openmeter/grant-allowance";
import { getPlatformDefaultApp } from "@/lib/platform-default-app";

const ADMIN_GRANT_SOURCES = new Set<GrantSource>([
  "manual",
  "promo",
  "plan_adjustment",
]);

function parsePositiveAmountUsdMicros(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  try {
    const parsed = BigInt(normalized);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

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

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const amountUsdMicros = parsePositiveAmountUsdMicros(body.amountUsdMicros);
    if (!amountUsdMicros) {
      return NextResponse.json(
        { error: "amountUsdMicros must be positive" },
        { status: 400 },
      );
    }

    const note =
      typeof body.note === "string" ? body.note.trim() : "";
    if (!note) {
      return NextResponse.json(
        { error: "note is required" },
        { status: 400 },
      );
    }

    const sourceRaw =
      typeof body.source === "string" ? body.source.trim() : "manual";
    const source = ADMIN_GRANT_SOURCES.has(sourceRaw as GrantSource)
      ? (sourceRaw as GrantSource)
      : null;
    if (!source) {
      return NextResponse.json(
        {
          error:
            "source must be one of: manual, promo, plan_adjustment",
        },
        { status: 400 },
      );
    }

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
