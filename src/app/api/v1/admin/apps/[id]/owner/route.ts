import { NextResponse } from "next/server";

import { reassignAppOwner } from "@/lib/admin-reassign-app-owner";
import { withSessionAdminGuardParams } from "@/lib/api-guards";

export const POST = withSessionAdminGuardParams<{ id: string }>(
  async (request, { params }) => {
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const rawOwnerId =
      typeof body === "object" && body !== null
        ? (body as { newOwnerUserId?: unknown }).newOwnerUserId
        : undefined;
    const newOwnerUserId = typeof rawOwnerId === "string" ? rawOwnerId.trim() : "";

    const result = await reassignAppOwner({
      appId: id,
      newOwnerUserId,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ success: true, ownerId: result.ownerId });
  },
);
