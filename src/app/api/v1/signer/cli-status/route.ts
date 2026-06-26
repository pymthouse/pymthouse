import { NextResponse } from "next/server";
import { withAdminGuard } from "@/lib/api-guards";
import { fetchSignerCliStatus } from "@/lib/signer-cli";

/**
 * GET /api/v1/signer/cli-status
 *
 * Returns live state from go-livepeer’s CLI API (via SIGNER_CLI_URL / DMZ
 * /__signer_cli when configured), the same data
 * that livepeer_cli reads. Admin-only.
 */
export const GET = withAdminGuard(async () => {
  const status = await fetchSignerCliStatus();
  return NextResponse.json(status);
});
