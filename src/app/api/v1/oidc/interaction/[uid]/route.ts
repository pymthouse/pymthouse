/**
 * Interaction endpoint — called after login/consent to complete the OIDC flow.
 *
 * GET  /api/v1/oidc/interaction/:uid — return interaction details (for consent page)
 * POST /api/v1/oidc/interaction/:uid — submit interaction result (login or consent)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  completeOidcInteraction,
  readOidcInteraction,
} from "@/domains/oidc-platform/runtime/interactions";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ uid: string }> },
): Promise<NextResponse> {
  const { uid } = await params;
  const result = await readOidcInteraction(request, uid);
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ uid: string }> },
): Promise<NextResponse> {
  const { uid } = await params;
  const result = await completeOidcInteraction({ request, uid });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.redirect(result.redirectTo, { status: 302 });
}
