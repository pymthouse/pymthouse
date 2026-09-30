/**
 * Interaction endpoint — called after login/consent to complete the OIDC flow.
 *
 * GET  /api/v1/oidc/interaction/:uid — return interaction details (for consent page)
 * POST /api/v1/oidc/interaction/:uid — submit interaction result (login or consent)
 */

import { NextRequest } from "next/server";
import {
  handleOidcInteractionGet,
  handleOidcInteractionPost,
} from "@/lib/oidc/interaction-api";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ uid: string }> },
) {
  const { uid } = await context.params;
  return handleOidcInteractionGet(request, uid);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ uid: string }> },
) {
  const { uid } = await context.params;
  return handleOidcInteractionPost(request, uid);
}
