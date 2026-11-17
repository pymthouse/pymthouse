import type { NextRequest, NextResponse } from "next/server";
import { getIssuer } from "@/platform/oidc/issuer-urls";
import {
  handleTokenExchange,
  isTokenExchangeGrant,
  TokenExchangeError,
} from "@/domains/oidc-platform/runtime/token-exchange";
import {
  handleGatewayTokenExchange,
  isGatewayTokenExchangeRequest,
} from "@/domains/oidc-platform/runtime/gateway-token-exchange";
import {
  handleDeviceApprovalTokenExchange,
  isDeviceApprovalTokenExchangeRequest,
} from "@/domains/oidc-platform/runtime/device-token-exchange";
import { rotateProgrammaticRefreshToken } from "@/domains/oidc-platform/runtime/programmatic-tokens";
import {
  clientCredentialsFromTokenRequest,
  ensureResourceIndicator,
} from "../service/token-request";

export async function interceptOidcTokenRequest(params: {
  request: NextRequest;
  path: string;
  contentType: string;
  body: Buffer<ArrayBufferLike> | null;
}): Promise<{ response: NextResponse | null; body: Buffer<ArrayBufferLike> | null }> {
  const { request, path, contentType } = params;
  let body = params.body;

  if (
    request.method === "POST" &&
    path === "/token" &&
    contentType.includes("application/x-www-form-urlencoded") &&
    body &&
    body.length > 0
  ) {
    const exchangeParams = new URLSearchParams(body.toString("utf-8"));
    const grantType = exchangeParams.get("grant_type") || "";

    if (grantType === "refresh_token") {
      const refreshToken = exchangeParams.get("refresh_token") || "";
      const { clientId, clientSecret } = clientCredentialsFromTokenRequest(request, exchangeParams);
      const refreshed = await rotateProgrammaticRefreshToken({
        refreshToken,
        clientId,
        clientSecret,
      });
      if (refreshed) {
        return {
          response: Response.json(refreshed, {
            headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
          }) as unknown as NextResponse,
          body,
        };
      }
    }

    if (isTokenExchangeGrant(grantType)) {
      const { clientId, clientSecret } = clientCredentialsFromTokenRequest(request, exchangeParams);
      const subjectTokenType = exchangeParams.get("subject_token_type") || "";
      const resourceParam = exchangeParams.get("resource");
      try {
        let result: unknown;
        if (
          isDeviceApprovalTokenExchangeRequest({
            grantType,
            subjectTokenType,
            resource: resourceParam,
          })
        ) {
          result = await handleDeviceApprovalTokenExchange({
            clientId,
            clientSecret,
            subjectToken: exchangeParams.get("subject_token") || "",
            subjectTokenType,
            resource: resourceParam,
            requestedTokenType: exchangeParams.get("requested_token_type"),
            audience: exchangeParams.getAll("audience"),
          });
        } else if (
          isGatewayTokenExchangeRequest({
            grantType,
            clientId,
            subjectTokenType,
            resource: resourceParam,
          })
        ) {
          result = await handleGatewayTokenExchange({
            clientId,
            clientSecret,
            subjectToken: exchangeParams.get("subject_token") || "",
            subjectTokenType,
            resource: resourceParam,
            requestedTokenType: exchangeParams.get("requested_token_type"),
            audience: exchangeParams.getAll("audience"),
          });
        } else {
          result = await handleTokenExchange({
            clientId,
            clientSecret,
            subjectToken: exchangeParams.get("subject_token") || "",
            subjectTokenType,
            scope: exchangeParams.get("scope") || undefined,
            resource: exchangeParams.get("resource") || undefined,
          });
        }
        return {
          response: Response.json(result, {
            headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
          }) as unknown as NextResponse,
          body,
        };
      } catch (err) {
        if (err instanceof TokenExchangeError) {
          return {
            response: Response.json(
              { error: err.code, error_description: err.publicDescription },
              { status: 400 },
            ) as unknown as NextResponse,
            body,
          };
        }
        return {
          response: Response.json(
            {
              error: "server_error",
              error_description: "Internal error during token exchange",
            },
            { status: 500 },
          ) as unknown as NextResponse,
          body,
        };
      }
    }
  }

  if (
    request.method === "POST" &&
    contentType.includes("application/x-www-form-urlencoded") &&
    body &&
    body.length > 0 &&
    (path === "/device/auth" || path === "/token")
  ) {
    const form = new URLSearchParams(body.toString("utf-8"));
    body = ensureResourceIndicator(form, path, getIssuer());
  }

  return { response: null, body };
}
