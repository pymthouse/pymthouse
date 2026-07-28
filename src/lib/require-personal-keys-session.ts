import { NextResponse } from "next/server";
import type { Session } from "next-auth";

const DEFAULT_ADMIN_REJECT =
  "Platform admins manage keys per app, not via personal keys";

type SessionFields = {
  id?: string;
  role?: string;
};

/**
 * Shared gate for personal-key API routes: require a signed-in developer
 * (reject missing session and platform admin/operator roles).
 */
export function requirePersonalKeysSession(
  session: Session | null,
  options?: { adminRejectedMessage?: string },
): { userId: string } | NextResponse {
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = session.user as SessionFields;
  if (!user.id) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
  }

  if (user.role === "admin" || user.role === "operator") {
    return NextResponse.json(
      {
        error: options?.adminRejectedMessage ?? DEFAULT_ADMIN_REJECT,
      },
      { status: 403 },
    );
  }

  return { userId: user.id };
}

export function isPersonalKeysSessionResult(
  value: { userId: string } | NextResponse,
): value is { userId: string } {
  return !(value instanceof NextResponse);
}
