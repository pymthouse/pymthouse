import { NextResponse } from "next/server";

import { buildAuthorizationServerMetadata } from "@/lib/oidc/as-metadata";

/**
 * RFC 8414 authorization server metadata (path-aware issuer form).
 * Issuer is `…/api/v1/oidc`, so the well-known path is:
 * `/.well-known/oauth-authorization-server/api/v1/oidc`
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildAuthorizationServerMetadata(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json",
    },
  });
}
