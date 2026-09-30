import { NextResponse } from "next/server";

import { withAdminGuardParams } from "@/lib/api-guards";
import {
  getAdminBillingApp,
  parseAppUserListQuery,
} from "@/lib/billing/admin-app-rollup";

/**
 * GET /api/v1/admin/billing/apps/[appId]?q=&page=&pageSize=
 * App detail with owner-rollup spendable and paginated M2M users.
 */
export const GET = withAdminGuardParams<{ appId: string }>(
  async (request, routeContext) => {
    const { appId } = await routeContext.params;
    const userQuery = parseAppUserListQuery(request.nextUrl.searchParams);
    const detail = await getAdminBillingApp(appId, userQuery);
    if (!detail) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  },
);
