import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyToken } from "@/domains/developer-apps/runtime/api-key-validation";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const result = await validateApiKeyToken(authHeader.slice(7));
  if (!result.ok) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }
  return NextResponse.json(result.body);
}
