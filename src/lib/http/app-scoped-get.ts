import { NextRequest, NextResponse } from "next/server";

export type AppScopedGetHandler = (
  request: NextRequest,
  clientId: string,
) => Promise<Response> | Response;

/**
 * App Router GET wrapper for `/apps/{id}/...` routes that delegate to a
 * handler keyed by the public client id.
 */
export function createAppScopedGet(handler: AppScopedGetHandler) {
  return async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const { id: clientId } = await params;
    if (!clientId?.trim()) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return handler(request, clientId.trim());
  };
}
