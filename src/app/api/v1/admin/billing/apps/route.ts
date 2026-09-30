import { NextResponse } from "next/server";

import { withAdminGuard } from "@/lib/api-guards";
import {
  listAdminBillingApps,
  parseAppListQuery,
} from "@/lib/billing/admin-app-rollup";

/**
 * GET /api/v1/admin/billing/apps?q=&page=&pageSize=&status=&billingMode=
 * App-primary list for customer-service: owner, billing mode, M2M user counts,
 * and owner-rollup blocked users as needs-attention.
 */
export const GET = withAdminGuard(async (request) => {
  const query = parseAppListQuery(request.nextUrl.searchParams);
  const result = await listAdminBillingApps(query);
  return NextResponse.json(result);
});
