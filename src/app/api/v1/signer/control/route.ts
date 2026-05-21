import { NextRequest, NextResponse } from "next/server";
import { getSignerAdminUser } from "@/domains/signer-runtime/runtime/admin-auth";
import { controlSigner } from "@/domains/signer-runtime/runtime/signer-admin";

/**
 * POST /api/v1/signer/control -- Control plane for the signer container
 *
 * Body: { action: "start" | "stop" | "restart" | "sync" }
 */
export async function POST(request: NextRequest) {
  const admin = await getSignerAdminUser(request);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await controlSigner(await request.json());
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json(result.body);
}
