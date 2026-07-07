import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import {
  PublicClientIdPathParamSchema,
  ExternalUserIdParamSchema,
} from "@/lib/openapi/schemas/common";
import {
  OAuthErrorResponseSchema,
  ProgrammaticTokenResponseSchema,
  ProgrammaticUserTokenRequestBodySchema,
  SignerSessionSchema,
  TokenExchangeRequestSchema,
} from "@/lib/openapi/schemas/credentials";
import { z } from "@/lib/openapi/zod";

const clientIdParam = PublicClientIdPathParamSchema;
const externalUserIdParam = ExternalUserIdParamSchema;

defineRouteMetadata("post", "/api/v1/apps/{clientId}/oidc/token", {
  tags: ["Credentials"],
  summary: "RFC 8693 signer session token exchange",
  description:
    "Exchanges a user access JWT (device code / authorization code) or per-app-user API key " +
    "(`pmth_*`) for a short-lived signer JWT. The `{clientId}` path segment is the public " +
    "OAuth app client id. Authenticate with the end-user `subject_token`; optional HTTP Basic " +
    "with the M2M client is supported for server-side callers.",
  request: {
    params: z.object({ clientId: clientIdParam }),
    body: {
      content: {
        "application/x-www-form-urlencoded": { schema: TokenExchangeRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Signer session",
      content: { "application/json": { schema: SignerSessionSchema } },
    },
    400: {
      description: "Invalid request, grant, target, or unsupported token type",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    401: {
      description: "Invalid client credentials",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    404: {
      description: "App not found",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
  },
});

defineRouteMetadata("post", "/api/v1/apps/{clientId}/users/{externalUserId}/token", {
  tags: ["Credentials"],
  summary: "Mint programmatic user JWT (M2M)",
  description:
    "Confidential client (`m2m_*` + secret) mints a user-scoped access token. " +
    "Subject-token acquisition strategy for RFC 8693 signer exchange at " +
    "`POST /api/v1/apps/{clientId}/oidc/token`.",
  security: [{ m2mBasic: [] }, { bearerUserJwt: [] }],
  request: {
    params: z.object({
      clientId: clientIdParam,
      externalUserId: externalUserIdParam,
    }),
    body: {
      content: {
        "application/json": { schema: ProgrammaticUserTokenRequestBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Programmatic user token.",
      content: {
        "application/json": { schema: ProgrammaticTokenResponseSchema },
      },
    },
    400: {
      description: "Invalid scope or request.",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    401: {
      description: "M2M authentication failed.",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    403: {
      description: "Forbidden (scope or cross-app).",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    404: {
      description: "App or user not found.",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
  },
});

defineRouteMetadata("post", "/api/v1/oidc/token", {
  virtual: true,
  tags: ["OIDC"],
  summary: "OIDC provider token endpoint",
  description:
    "Served by oidc-provider at `/api/v1/oidc/token`. Standard OAuth/OIDC grants: " +
    "`authorization_code`, `refresh_token`, `client_credentials`, device code, and " +
    "pymthouse-specific exchanges (device approval, gateway session). " +
    "Signer session exchange uses `POST /api/v1/apps/{clientId}/oidc/token` instead. " +
    "See OpenID Configuration for the full parameter matrix.",
  responses: {
    200: { description: "Token response per OAuth/OIDC." },
    400: { description: "OAuth error." },
  },
});
