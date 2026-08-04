import { NextResponse } from "next/server";
import { and, count, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerBillingConfig, users } from "@/db/schema";
import { withSessionAdminGuard } from "@/lib/api-guards";
import { mergeOwnerBilling } from "@/lib/billing/owner-billing-config";
import {
  platformDefaultApplicationFeeBps,
  platformDefaultEndUserCap,
} from "@/lib/billing/platform-billing-defaults";
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function parsePositiveInt(
  raw: string | null,
  fallback: number,
  max?: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  if (max != null && n > max) return max;
  return n;
}

/**
 * GET /api/v1/admin/billing/owners?q=&page=&pageSize=
 * Search developer accounts with resolved cost-rail billing summary.
 */
export const GET = withSessionAdminGuard(async (request) => {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const page = parsePositiveInt(request.nextUrl.searchParams.get("page"), 1);
  const pageSize = parsePositiveInt(
    request.nextUrl.searchParams.get("pageSize"),
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const offset = (page - 1) * pageSize;

  const platformDefault = await resolvePlatformOwnerStarterIncludedUsdMicros();
  const defaults = {
    starterIncludedUsdMicros: platformDefault,
    endUserCap: platformDefaultEndUserCap(),
    applicationFeeBps: platformDefaultApplicationFeeBps(),
  };

  const roleFilter = or(eq(users.role, "developer"), eq(users.role, "admin"));
  const searchFilter =
    q.length > 0
      ? or(
          ilike(users.email, `%${q}%`),
          ilike(users.name, `%${q}%`),
          eq(users.id, q),
        )
      : undefined;
  const whereClause = searchFilter ? and(roleFilter, searchFilter) : roleFilter;

  const [totalRow] = await db
    .select({ total: count() })
    .from(users)
    .where(whereClause);
  const totalCount = Number(totalRow?.total ?? 0);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      starterIncludedUsdMicros: ownerBillingConfig.starterIncludedUsdMicros,
      endUserCap: ownerBillingConfig.endUserCap,
      applicationFeeBps: ownerBillingConfig.applicationFeeBps,
      note: ownerBillingConfig.note,
    })
    .from(users)
    .leftJoin(
      ownerBillingConfig,
      eq(ownerBillingConfig.ownerUserId, users.id),
    )
    .where(whereClause)
    .orderBy(sql`${users.email} asc nulls last`)
    .limit(pageSize)
    .offset(offset);

  const owners = rows.map((row) => {
    const hasRow =
      row.starterIncludedUsdMicros != null ||
      row.endUserCap != null ||
      row.applicationFeeBps != null ||
      row.note != null;
    const overrides = hasRow
      ? {
          starterIncludedUsdMicros: row.starterIncludedUsdMicros,
          endUserCap: row.endUserCap,
          applicationFeeBps: row.applicationFeeBps,
          note: row.note,
        }
      : null;
    const resolved = mergeOwnerBilling(overrides, defaults);
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      resolved,
      overrides,
    };
  });

  return NextResponse.json({
    owners,
    page,
    pageSize,
    totalCount,
    platformDefault: {
      starterIncludedUsdMicros: platformDefault,
      endUserCap: defaults.endUserCap,
      applicationFeeBps: defaults.applicationFeeBps,
    },
  });
});
