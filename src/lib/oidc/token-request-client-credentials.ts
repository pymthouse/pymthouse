import { NextRequest } from "next/server";
import { decodeBasicAuthComponent } from "@/lib/auth";

/** RFC 6749 §2.3.1 Appendix B decoding for `client_id` / `client_secret`. */
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
      /* fall through to body */
    }
  }
  return {
    clientId: params.get("client_id") || "",
    clientSecret: params.get("client_secret") || "",
  };
}
