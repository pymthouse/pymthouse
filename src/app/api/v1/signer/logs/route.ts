import { NextRequest, NextResponse } from "next/server";
import { getSignerAdminUser } from "@/domains/signer-runtime/runtime/admin-auth";
import { readSignerLogs } from "@/domains/signer-runtime/runtime/signer-admin";

/**
 * GET /api/v1/signer/logs -- Fetch recent container logs
 */
export async function GET(request: NextRequest) {
  const admin = await getSignerAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await readSignerLogs(request));
}
