import type { NextRequest } from "next/server";
import { decodeBasicAuthComponent } from "@/domains/identity-access/runtime/request-auth";

export const RESOURCE_REQUIRED_GRANTS = new Set([
  "urn:ietf:params:oauth:grant-type:device_code",
  "authorization_code",
  "refresh_token",
]);

export function clientCredentialsFromTokenRequest(
  request: NextRequest,
  params: URLSearchParams,
): { clientId: string; clientSecret: string } {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
      const idx = decoded.indexOf(":");
      if (idx > 0) {
        return {
          clientId: decodeBasicAuthComponent(decoded.slice(0, idx)),
          clientSecret: decodeBasicAuthComponent(decoded.slice(idx + 1)),
        };
      }
    } catch {
      /* fall through */
    }
  }
  return {
    clientId: params.get("client_id") || "",
    clientSecret: params.get("client_secret") || "",
  };
}

export function ensureResourceIndicator(params: URLSearchParams, path: string, issuer: string): Buffer {
  const grantType = params.get("grant_type");
  const needsResource =
    path === "/device/auth" || (grantType && RESOURCE_REQUIRED_GRANTS.has(grantType));
  if (needsResource && !params.has("resource")) {
    params.set("resource", issuer);
  }
  return Buffer.from(params.toString(), "utf-8");
}
