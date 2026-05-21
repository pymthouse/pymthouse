/**
 * Device verification API — custom endpoint for the device verification UI.
 *
 * Since we use our own React UI for device code verification (instead of the
 * provider's built-in HTML forms), this endpoint wraps the provider's adapter
 * to look up, approve, or deny device codes.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleDeviceVerificationRequest } from "@/domains/oidc-platform/runtime/device-verification";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const result = await handleDeviceVerificationRequest(request);
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
