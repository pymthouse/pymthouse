import type { NextRequest, NextResponse } from "next/server";
import { getProvider } from "./provider-instance";
import { normalizeProviderPath } from "@/platform/oidc/routes";
import { OIDC_MOUNT_PATH, getIssuer } from "@/platform/oidc/issuer-urls";
import { getRegisteredRedirectOrigins } from "@/domains/oidc-platform/runtime/clients";
import { isVerifiedCustomDomain } from "@/domains/oidc-platform/runtime/custom-domains";
import { getSecureHeaders } from "@/platform/oidc/security";
import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import {
  deriveExternalOriginFromHeaders,
  resolveRedirectLocation,
} from "../service/provider-redirects";
import { interceptOidcTokenRequest } from "./token-request";
import { getTrustedOidcOrigins } from "./provider-origins";

export async function handleOidcCatchall(request: NextRequest): Promise<NextResponse> {
  const provider = await getProvider();
  const registeredRedirectOriginsList = await getRegisteredRedirectOrigins();
  const trustedOidcOriginsSet = await getTrustedOidcOrigins();

  const url = new URL(request.url);
  let path = url.pathname;
  if (path.startsWith(OIDC_MOUNT_PATH)) {
    path = path.slice(OIDC_MOUNT_PATH.length) || "/";
  }
  path = normalizeProviderPath(path);

  let body: Buffer<ArrayBufferLike> | null = request.body
    ? Buffer.from(await request.arrayBuffer())
    : null;
  const contentType = request.headers.get("content-type") || "";
  const intercepted = await interceptOidcTokenRequest({
    request,
    path,
    contentType,
    body,
  });
  if (intercepted.response) {
    return intercepted.response;
  }
  body = intercepted.body;

  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = request.method;
  req.url = path + url.search;
  (req as IncomingMessage & { baseUrl?: string }).baseUrl = OIDC_MOUNT_PATH;
  request.headers.forEach((value, key) => {
    req.headers[key.toLowerCase()] = value;
  });

  const externalOrigin = deriveExternalOriginFromHeaders(request.headers);
  const externalUrl = new URL(externalOrigin);
  req.headers.host = externalUrl.host;
  req.headers["x-forwarded-proto"] = externalUrl.protocol.replace(":", "");
  req.headers["x-forwarded-host"] = externalUrl.host;

  if (body && body.length > 0) {
    req.headers["content-length"] = String(body.length);
    req.push(body);
  }
  req.push(null);

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = function (chunk: any, ...args: any[]) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return originalWrite(chunk, ...args);
  } as any;

  return new Promise<NextResponse>((resolve) => {
    res.end = async function (chunk?: any, ...args: any[]) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

      const responseBody = Buffer.concat(chunks);
      const statusCode = res.statusCode || 200;
      const headers = new Headers();
      const rawHeaders = res.getHeaders();
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (value !== undefined) {
          if (Array.isArray(value)) {
            for (const v of value) headers.append(key, String(v));
          } else {
            headers.set(key, String(value));
          }
        }
      }

      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = headers.get("location");
        if (location) {
          const allowedOrigins = new Set([
            new URL(externalOrigin).origin,
            ...registeredRedirectOriginsList,
            ...trustedOidcOriginsSet,
          ]);
          const redirectResponse = Response.redirect(
            resolveRedirectLocation(location, externalOrigin, allowedOrigins),
            statusCode,
          ) as unknown as NextResponse;
          const setCookies = rawHeaders["set-cookie"];
          if (setCookies) {
            const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
            for (const cookie of cookies) {
              redirectResponse.headers.append("Set-Cookie", cookie);
            }
          }
          for (const [key, value] of Object.entries(getSecureHeaders(false))) {
            redirectResponse.headers.set(key, value);
          }
          resolve(redirectResponse);
          return originalEnd(chunk, ...args);
        }
      }

      let finalBody: Buffer | null = responseBody.length > 0 ? responseBody : null;
      const ct = headers.get("content-type") || "";
      if (finalBody && ct.includes("application/json") && path === "/device/auth") {
        try {
          const json = JSON.parse(finalBody.toString("utf-8"));
          if (json.verification_uri) {
            const deviceParams = new URLSearchParams();
            if (json.user_code) deviceParams.set("user_code", json.user_code);
            if (body && body.length > 0) {
              try {
                const form = new URLSearchParams(body.toString("utf-8"));
                const deviceClientId = form.get("client_id");
                if (deviceClientId) deviceParams.set("client_id", deviceClientId);
              } catch {}
            }
            deviceParams.set("iss", getIssuer());
            const qs = deviceParams.toString();
            const verificationBase = `${externalOrigin}/oidc/device`;
            json.verification_uri = verificationBase;
            if (json.user_code) {
              json.verification_uri_complete = qs ? `${verificationBase}?${qs}` : verificationBase;
            }
            finalBody = Buffer.from(JSON.stringify(json), "utf-8");
            headers.set("content-length", String(finalBody.length));
          }
        } catch {}
      }

      const requestHost = req.headers["x-forwarded-host"] || req.headers.host || "";
      const hostStr = Array.isArray(requestHost) ? requestHost[0] : requestHost;
      const isCustomDomain = await isVerifiedCustomDomain(hostStr);
      for (const [key, value] of Object.entries(getSecureHeaders(isCustomDomain))) {
        headers.set(key, value);
      }

      const nextResponse = new Response(finalBody ? new Uint8Array(finalBody) : null, {
        status: statusCode,
        headers,
      }) as unknown as NextResponse;
      resolve(nextResponse);
      return originalEnd(chunk, ...args);
    } as any;

    const callback = provider.callback();
    callback(req, res);
  });
}
