import { NextRequest, NextResponse } from "next/server";
import { getSignerAdminUser } from "@/domains/signer-runtime/runtime/admin-auth";
import {
  readSignerStatus,
  updateSignerStatusConfig,
} from "@/domains/signer-runtime/runtime/signer-admin";

/**
 * GET /api/v1/signer -- Get singleton signer status + config
 */
export async function GET(request: NextRequest) {
  const admin = await getSignerAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await readSignerStatus());
}

/**
 * PATCH /api/v1/signer -- Update signer config
 * Changing config requires a restart to take effect.
 */
export async function PATCH(request: NextRequest) {
  const admin = await getSignerAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await updateSignerStatusConfig(await request.json());
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json(result.body);
}
