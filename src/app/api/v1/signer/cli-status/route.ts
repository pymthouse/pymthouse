import { NextRequest, NextResponse } from "next/server";
import { getSignerAdminUser } from "@/domains/signer-runtime/runtime/admin-auth";
import { readSignerCliStatus } from "@/domains/signer-runtime/runtime/signer-admin";

/**
 * GET /api/v1/signer/cli-status
 *
 * Returns live state from go-livepeer’s CLI API (via SIGNER_CLI_URL / DMZ
 * /__signer_cli when configured), the same data
 * that livepeer_cli reads. Admin-only.
 */
export async function GET(request: NextRequest) {
  const admin = await getSignerAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await readSignerCliStatus());
}
