import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { verifyAccountSessionBinding } from "@/lib/account-session-binding";
import { authOptions } from "@/lib/next-auth-options";

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as Record<string, unknown> | undefined;
  const userId = typeof sessionUser?.id === "string" ? sessionUser.id : "";
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const rawSessionJwt =
    typeof body === "object" && body !== null
      ? (body as { turnkeySessionJwt?: unknown }).turnkeySessionJwt
      : undefined;
  const turnkeySessionJwt =
    typeof rawSessionJwt === "string" ? rawSessionJwt : "";

  const result = await verifyAccountSessionBinding({
    userId,
    turnkeySessionJwt,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, bound: false },
      { status: result.status },
    );
  }
  return NextResponse.json({ bound: true });
}
