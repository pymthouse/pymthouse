/**
 * Catch-all route that delegates all standard OIDC endpoints to node-oidc-provider.
 *
 * Handles: /api/v1/oidc/auth, /api/v1/oidc/token, /api/v1/oidc/userinfo,
 * /api/v1/oidc/jwks, /api/v1/oidc/device/auth, .well-known/openid-configuration, etc.
 */

import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/oidc/provider";
import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import { normalizeProviderPath } from "@/lib/oidc/routes";
import {
  OIDC_MOUNT_PATH,
  getIssuer,
  getPublicOrigin,
} from "@/lib/oidc/issuer-urls";
import { getRegisteredRedirectOrigins } from "@/lib/oidc/clients";
import { isVerifiedCustomDomain } from "@/lib/oidc/custom-domains";
import { getSecureHeaders } from "@/lib/oidc/security";
import { deriveExternalOriginFromHeaders, resolveRedirectLocation, getTrustedOidcOrigins } from "./utils";
import { isTokenExchangeGrant, handleTokenExchange, TokenExchangeError } from "@/lib/oidc/token-exchange";
import {
  handleGatewayTokenExchange,
  isGatewayTokenExchangeRequest,
} from "@/lib/oidc/gateway-token-exchange";
import { clientCredentialsFromTokenRequest } from "@/lib/oidc/token-request-client-credentials";
import {
  handleDeviceApprovalTokenExchange,
  isDeviceApprovalTokenExchangeRequest,
} from "@/lib/oidc/device-token-exchange";
import {
  handleMintUserSignerToken,
  handleM2mOwnerSignJob,
  isMintUserSignerTokenRequest,
  isM2mOwnerSignJobRequest,
  MintUserSignerTokenError,
} from "@/lib/oidc/mint-user-signer-token";
import {
  assertSignJobNotMixedWithAdmin,
  SignJobScopeExclusivityError,
} from "@/lib/oidc/scopes";
import { handleSignerJwtTokenExchange, isSignerJwtTokenExchangeRequest } from "@/lib/oidc/signer-jwt-token-exchange";
import { rotateProgrammaticRefreshToken } from "@/lib/oidc/programmatic-tokens";

const RESOURCE_REQUIRED_GRANTS = new Set([
  "urn:ietf:params:oauth:grant-type:device_code",
  "authorization_code",
  "refresh_token",
]);

const DEBUG_OIDC_LOGS = process.env.OIDC_DEBUG_LOGS === "1";
const NO_STORE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

function requestedScopesFromParams(params: URLSearchParams): string[] {
  return (params.get("scope") || "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function mintSignerTokenErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof MintUserSignerTokenError) {
    return NextResponse.json(
      { error: err.code, error_description: err.message },
      { status: err.status },
    );
  }
  if (err instanceof SignJobScopeExclusivityError) {
    return NextResponse.json(
      { error: err.code, error_description: err.message },
      { status: 400 },
    );
  }
  return null;
}

function jsonNoStore(body: unknown, extraHeaders?: Record<string, string>): NextResponse {
  return NextResponse.json(body, {
    headers: { ...NO_STORE_HEADERS, ...extraHeaders },
  });
}

async function handleMintSignerTokenGrant(
  request: NextRequest,
  exchangeParams: URLSearchParams,
): Promise<NextResponse | null> {
  if (!isMintUserSignerTokenRequest(exchangeParams)) {
    return null;
  }
  const { clientId, clientSecret } = clientCredentialsFromTokenRequest(
    request,
    exchangeParams,
  );
  try {
    assertSignJobNotMixedWithAdmin(requestedScopesFromParams(exchangeParams));
    const result = await handleMintUserSignerToken({
      clientId,
      clientSecret,
      externalUserId: exchangeParams.get("external_user_id") || "",
      scope: exchangeParams.get("scope"),
    });
    return jsonNoStore(result);
  } catch (err) {
    const response = mintSignerTokenErrorResponse(err);
    if (response) {
      return response;
    }
    console.error("[OIDC] mint user signer token error:", err);
    return NextResponse.json(
      { error: "server_error", error_description: "Internal error during token mint" },
      { status: 500 },
    );
  }
}

async function handleM2mOwnerSignJobGrant(
  request: NextRequest,
  exchangeParams: URLSearchParams,
): Promise<NextResponse | null> {
  if (!isM2mOwnerSignJobRequest(exchangeParams)) {
    return null;
  }
  const { clientId, clientSecret } = clientCredentialsFromTokenRequest(
    request,
    exchangeParams,
  );
  try {
    assertSignJobNotMixedWithAdmin(requestedScopesFromParams(exchangeParams));
    const result = await handleM2mOwnerSignJob({
      clientId,
      clientSecret,
    });
    return jsonNoStore(result);
  } catch (err) {
    const response = mintSignerTokenErrorResponse(err);
    if (response) {
      return response;
    }
    console.error("[OIDC] M2M owner sign:job mint error:", err);
    return NextResponse.json(
      { error: "server_error", error_description: "Internal error during token mint" },
      { status: 500 },
    );
  }
}

async function tryDeviceApprovalExchange(
  clientId: string,
  clientSecret: string,
  exchangeParams: URLSearchParams,
  grantType: string,
  subjectTokenType: string,
  resourceParam: string | null,
): Promise<NextResponse | null> {
  if (
    !isDeviceApprovalTokenExchangeRequest({
      grantType,
      subjectTokenType,
      resource: resourceParam,
    })
  ) {
    return null;
  }
  const result = await handleDeviceApprovalTokenExchange({
    clientId,
    clientSecret,
    subjectToken: exchangeParams.get("subject_token") || "",
    subjectTokenType,
    resource: resourceParam,
    requestedTokenType: exchangeParams.get("requested_token_type"),
    audience: exchangeParams.getAll("audience"),
  });
  return jsonNoStore(result);
}

async function trySignerJwtExchange(
  clientId: string,
  clientSecret: string,
  exchangeParams: URLSearchParams,
  grantType: string,
  subjectTokenType: string,
  resourceParam: string | null,
): Promise<NextResponse | null> {
  if (
    !isSignerJwtTokenExchangeRequest({
      grantType,
      subjectTokenType,
      resource: resourceParam,
      audience: exchangeParams.getAll("audience"),
    })
  ) {
    return null;
  }
  const result = await handleSignerJwtTokenExchange({
    clientId,
    clientSecret,
    subjectToken: exchangeParams.get("subject_token") || "",
    subjectTokenType,
    resource: resourceParam,
    audience: exchangeParams.getAll("audience"),
  });
  return jsonNoStore(result, {
    Deprecation: "true",
    Link: '</api/v1/apps/{clientId}/oidc/token>; rel="successor-version"',
    Sunset: "2026-10-01",
  });
}

async function tryGatewayExchange(
  clientId: string,
  clientSecret: string,
  exchangeParams: URLSearchParams,
  grantType: string,
  subjectTokenType: string,
  resourceParam: string | null,
): Promise<NextResponse | null> {
  if (
    !isGatewayTokenExchangeRequest({
      grantType,
      clientId,
      subjectTokenType,
      resource: resourceParam,
      audience: exchangeParams.getAll("audience"),
    })
  ) {
    return null;
  }
  const result = await handleGatewayTokenExchange({
    clientId,
    clientSecret,
    subjectToken: exchangeParams.get("subject_token") || "",
    subjectTokenType,
    resource: resourceParam,
    requestedTokenType: exchangeParams.get("requested_token_type"),
    audience: exchangeParams.getAll("audience"),
  });
  return jsonNoStore(result);
}

async function handleTokenExchangeGrants(
  request: NextRequest,
  exchangeParams: URLSearchParams,
  grantType: string,
): Promise<NextResponse | null> {
  if (!isTokenExchangeGrant(grantType)) {
    return null;
  }
  const { clientId, clientSecret } = clientCredentialsFromTokenRequest(
    request,
    exchangeParams,
  );
  const subjectTokenType = exchangeParams.get("subject_token_type") || "";
  const resourceParam = exchangeParams.get("resource");
  try {
    const deviceApproval = await tryDeviceApprovalExchange(
      clientId,
      clientSecret,
      exchangeParams,
      grantType,
      subjectTokenType,
      resourceParam,
    );
    if (deviceApproval) {
      return deviceApproval;
    }

    const signerJwt = await trySignerJwtExchange(
      clientId,
      clientSecret,
      exchangeParams,
      grantType,
      subjectTokenType,
      resourceParam,
    );
    if (signerJwt) {
      return signerJwt;
    }

    const gateway = await tryGatewayExchange(
      clientId,
      clientSecret,
      exchangeParams,
      grantType,
      subjectTokenType,
      resourceParam,
    );
    if (gateway) {
      return gateway;
    }

    const result = await handleTokenExchange({
      clientId,
      clientSecret,
      subjectToken: exchangeParams.get("subject_token") || "",
      subjectTokenType,
      scope: exchangeParams.get("scope") || undefined,
      resource: exchangeParams.get("resource") || undefined,
    });
    return jsonNoStore(result);
  } catch (err) {
    if (err instanceof TokenExchangeError) {
      console.warn("[OIDC] token exchange rejected", {
        code: err.code,
        detail: err.message,
      });
      return NextResponse.json(
        { error: err.code, error_description: err.publicDescription },
        { status: 400 },
      );
    }
    console.error("[OIDC] token exchange error:", err);
    return NextResponse.json(
      { error: "server_error", error_description: "Internal error during token exchange" },
      { status: 500 },
    );
  }
}

async function maybeInterceptTokenEndpoint(
  request: NextRequest,
  path: string,
  body: Buffer | null,
): Promise<NextResponse | null> {
  const contentType = request.headers.get("content-type") || "";
  if (
    request.method !== "POST" ||
    path !== "/token" ||
    !contentType.includes("application/x-www-form-urlencoded") ||
    !body ||
    body.length === 0
  ) {
    return null;
  }

  const exchangeParams = new URLSearchParams(body.toString("utf-8"));
  const grantType = exchangeParams.get("grant_type") || "";

  if (grantType === "refresh_token") {
    const refreshToken = exchangeParams.get("refresh_token") || "";
    const { clientId, clientSecret } = clientCredentialsFromTokenRequest(
      request,
      exchangeParams,
    );
    const refreshed = await rotateProgrammaticRefreshToken({
      refreshToken,
      clientId,
      clientSecret,
    });
    if (refreshed) {
      return jsonNoStore(refreshed);
    }
  }

  const mintResponse = await handleMintSignerTokenGrant(request, exchangeParams);
  if (mintResponse) {
    return mintResponse;
  }

  const m2mResponse = await handleM2mOwnerSignJobGrant(request, exchangeParams);
  if (m2mResponse) {
    return m2mResponse;
  }

  return handleTokenExchangeGrants(request, exchangeParams, grantType);
}

function injectResourceIndicatorIfNeeded(
  request: NextRequest,
  path: string,
  body: Buffer | null,
): Buffer | null {
  const contentType = request.headers.get("content-type") || "";
  if (
    request.method !== "POST" ||
    !contentType.includes("application/x-www-form-urlencoded") ||
    !body ||
    body.length === 0 ||
    (path !== "/device/auth" && path !== "/token")
  ) {
    return body;
  }
  const params = new URLSearchParams(body.toString("utf-8"));
  const grantType = params.get("grant_type");
  const needsResource =
    path === "/device/auth" || (!!grantType && RESOURCE_REQUIRED_GRANTS.has(grantType));
  if (needsResource && !params.has("resource")) {
    params.set("resource", getIssuer());
    return Buffer.from(params.toString(), "utf-8");
  }
  return body;
}

function copyNodeHeadersToWeb(rawHeaders: ReturnType<ServerResponse["getHeaders"]>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, String(v));
      }
    } else {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function buildRedirectOidcResponse(
  statusCode: number,
  location: string,
  externalOrigin: string,
  registeredRedirectOriginsList: Set<string>,
  trustedOidcOriginsSet: Set<string>,
  rawHeaders: ReturnType<ServerResponse["getHeaders"]>,
): NextResponse {
  const allowedOrigins = new Set([
    new URL(externalOrigin).origin,
    ...registeredRedirectOriginsList,
    ...trustedOidcOriginsSet,
  ]);
  const redirectResponse = NextResponse.redirect(
    resolveRedirectLocation(location, externalOrigin, allowedOrigins),
    statusCode as 301 | 302 | 303 | 307 | 308,
  );
  const setCookies = rawHeaders["set-cookie"];
  if (setCookies) {
    const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
    for (const cookie of cookies) {
      redirectResponse.headers.append("Set-Cookie", cookie);
    }
  }

  const redirectSecureHeaders = getSecureHeaders(false);
  for (const [key, value] of Object.entries(redirectSecureHeaders)) {
    redirectResponse.headers.set(key, value);
  }
  return redirectResponse;
}

function rewriteDeviceAuthVerificationUri(
  responseBody: Buffer,
  path: string,
  headers: Headers,
  body: Buffer | null,
  externalOrigin: string,
): Buffer | null {
  let finalBody: Buffer | null = responseBody.length > 0 ? responseBody : null;
  const ct = headers.get("content-type") || "";
  if (
    !finalBody ||
    !ct.includes("application/json") ||
    path !== "/device/auth"
  ) {
    return finalBody;
  }
  try {
    const json = JSON.parse(finalBody.toString("utf-8"));
    if (!json.verification_uri) {
      return finalBody;
    }
    const deviceParams = new URLSearchParams();
    if (json.user_code) {
      deviceParams.set("user_code", json.user_code);
    }
    if (body && body.length > 0) {
      try {
        const form = new URLSearchParams(body.toString("utf-8"));
        const deviceClientId = form.get("client_id");
        if (deviceClientId) {
          deviceParams.set("client_id", deviceClientId);
        }
      } catch {
        /* ignore */
      }
    }
    deviceParams.set("iss", getIssuer());
    const qs = deviceParams.toString();
    const verificationBase = `${externalOrigin}/oidc/device`;
    json.verification_uri = verificationBase;
    if (json.user_code) {
      json.verification_uri_complete = qs
        ? `${verificationBase}?${qs}`
        : verificationBase;
    }
    finalBody = Buffer.from(JSON.stringify(json), "utf-8");
    headers.set("content-length", String(finalBody.length));
  } catch {
    /* non-JSON body, pass through */
  }
  return finalBody;
}

/**
 * Convert a Web API Request/Response to the Node.js HTTP pair that
 * node-oidc-provider (a Koa app) expects, then convert the result back.
 */
async function handleOIDC(request: NextRequest): Promise<NextResponse> {
  const provider = await getProvider();
  const registeredRedirectOriginsList = await getRegisteredRedirectOrigins();
  const trustedOidcOriginsSet = await getTrustedOidcOrigins();

  // Build the path relative to the OIDC mount point.
  // The provider is mounted at /api/v1/oidc, so strip that prefix.
  const url = new URL(request.url);
  const mountPath = OIDC_MOUNT_PATH;
  let path = url.pathname;
  if (path.startsWith(mountPath)) {
    path = path.slice(mountPath.length) || "/";
  }

  // Alias legacy paths to node-oidc-provider routes.
  const normalizedPath = normalizeProviderPath(path);
  if (DEBUG_OIDC_LOGS && normalizedPath !== path) {
    console.info("[OIDC] route alias", { from: path, to: normalizedPath });
  }
  path = normalizedPath;

  // Create a Node.js IncomingMessage from the NextRequest
  let body: Buffer | null = request.body ? Buffer.from(await request.arrayBuffer()) : null;

  const intercepted = await maybeInterceptTokenEndpoint(request, path, body);
  if (intercepted) {
    return intercepted;
  }

  // RFC 8707 strict mode: ensure resource indicator is present on token-issuing
  // endpoints so access tokens are always audience-bound JWTs.
  body = injectResourceIndicatorIfNeeded(request, path, body);

  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = request.method;
  req.url = path + url.search;
  // OIDC context uses req.baseUrl to derive mountPath for urlFor() (returnTo, etc.).
  // Without this, mountPath is '' and resume URLs become /auth/:uid instead of /api/v1/oidc/auth/:uid.
  (req as IncomingMessage & { baseUrl?: string }).baseUrl = mountPath;

  // Copy headers from the incoming request
  request.headers.forEach((value, key) => {
    req.headers[key.toLowerCase()] = value;
  });

  // In production behind a reverse proxy, request.url is often the internal URL
  // (e.g. http://localhost:3001/...), which must never leak into provider redirects.
  // Resolve external origin from forwarded headers (fallback to NEXTAUTH_URL).
  const externalOrigin = deriveExternalOriginFromHeaders(request.headers);
  const externalUrl = new URL(externalOrigin);
  req.headers.host = externalUrl.host;
  req.headers["x-forwarded-proto"] = externalUrl.protocol.replace(":", "");
  req.headers["x-forwarded-host"] = externalUrl.host;

  // Push body data if present
  if (body && body.length > 0) {
    req.headers["content-length"] = String(body.length);
    req.push(body);
  }
  req.push(null); // Signal end of stream

  // Create a ServerResponse
  const res = new ServerResponse(req);

  // Capture the response
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = function (chunk: any, ...args: any[]) {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return originalWrite(chunk, ...args);
  } as any;

  return new Promise<NextResponse>((resolve) => {
    res.end = async function (chunk?: any, ...args: any[]) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const responseBody = Buffer.concat(chunks);
      const statusCode = res.statusCode || 200;
      const rawHeaders = res.getHeaders();
      const headers = copyNodeHeadersToWeb(rawHeaders);

      // Handle redirects — must forward Set-Cookie so the _interaction cookie reaches the browser
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = headers.get("location");
        if (location) {
          resolve(
            buildRedirectOidcResponse(
              statusCode,
              location,
              externalOrigin,
              registeredRedirectOriginsList,
              trustedOidcOriginsSet,
              rawHeaders,
            ),
          );
          return originalEnd(chunk, ...args);
        }
      }

      // Rewrite verification_uri in device auth responses to point to our
      // custom React UI instead of the provider's built-in HTML form.
      const finalBody = rewriteDeviceAuthVerificationUri(
        responseBody,
        path,
        headers,
        body,
        externalOrigin,
      );

      // Determine if this is a custom domain request
      const requestHost = req.headers["x-forwarded-host"] || req.headers.host || "";
      const hostStr = Array.isArray(requestHost) ? requestHost[0] : requestHost;
      const isCustomDomain = await isVerifiedCustomDomain(hostStr);

      // Add security headers
      const secureHeaders = getSecureHeaders(isCustomDomain);
      for (const [key, value] of Object.entries(secureHeaders)) {
        headers.set(key, value);
      }

      resolve(
        new NextResponse(finalBody ? new Uint8Array(finalBody) : null, {
          status: statusCode,
          headers,
        }),
      );
      return originalEnd(chunk, ...args);
    } as any;

    // Use the provider's callback to handle the request
    const callback = provider.callback();
    callback(req, res);
  });
}

export async function GET(request: NextRequest) {
  return handleOIDC(request);
}

export async function POST(request: NextRequest) {
  return handleOIDC(request);
}

export async function PUT(request: NextRequest) {
  return handleOIDC(request);
}

export async function DELETE(request: NextRequest) {
  return handleOIDC(request);
}

export async function OPTIONS(request: NextRequest) {
  return handleOIDC(request);
}
