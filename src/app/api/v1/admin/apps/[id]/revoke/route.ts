import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";
import { revokeReviewedDeveloperApp } from "@/domains/developer-apps/runtime/admin-apps";

/**
 * POST /api/v1/admin/apps/[id]/revoke
 * Revokes an approved app, reverting it to "submitted" (non-production).
 * The app returns to the review queue for re-approval.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as Record<string, unknown>).role as string;
  if (role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const result = await revokeReviewedDeveloperApp(clientId);
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}
