import { NextResponse } from "next/server";
import { and, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db/index";
import { ownerBillingConfig, users } from "@/db/schema";
import { withSessionAdminGuard } from "@/lib/api-guards";
import { mergeOwnerBilling } from "@/lib/billing/owner-billing-config";
import {
  platformDefaultApplicationFeeBps,
  platformDefaultEndUserCap,
} from "@/lib/billing/platform-billing-defaults";
import { resolvePlatformOwnerStarterIncludedUsdMicros } from "@/lib/billing/platform-owner-starter-default";

/**
 * GET /api/v1/admin/billing/owners?q=
 * Search developer accounts with resolved cost-rail billing summary.
 */
export const GET = withSessionAdminGuard(async (request) => {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
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
    .where(searchFilter ? and(roleFilter, searchFilter) : roleFilter)
    .orderBy(sql`${users.email} asc nulls last`)
    .limit(50);

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
    platformDefault: {
      starterIncludedUsdMicros: platformDefault,
      endUserCap: defaults.endUserCap,
      applicationFeeBps: defaults.applicationFeeBps,
    },
  });
});
