import { NextResponse } from "next/server";

import { withAdminGuard } from "@/lib/api-guards";
import {
  listAdminBillingOwners,
  parseOwnerListQuery,
} from "@/lib/billing/admin-owner-list";

/**
 * GET /api/v1/admin/billing/owners?q=&page=&pageSize=&status=
 * Search developer accounts (email, name, id, or app name) with cycle usage.
 * Ordered by most used. `status=blocked|overage|attention` filters the list.
 */
export const GET = withAdminGuard(async (request) => {
  const query = parseOwnerListQuery(request.nextUrl.searchParams);
  const result = await listAdminBillingOwners(query);
  return NextResponse.json(result);
});
