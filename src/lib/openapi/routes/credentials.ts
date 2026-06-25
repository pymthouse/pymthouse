import { defineRoute } from "@/lib/openapi/registry";
import {
  OAuthErrorSchema,
  PublicClientIdPathParamSchema,
  ExternalUserIdParamSchema,
} from "@/lib/openapi/schemas/common";
import {
  ApiKeySignerSessionRequestBodySchema,
  ApiKeyTokenRequestBodySchema,
  FacadeApiKeyExchangeRequestBodySchema,
  OAuthErrorResponseSchema,
  ProgrammaticTokenResponseSchema,
  ProgrammaticUserTokenRequestBodySchema,
  SignerSessionSchema,
} from "@/lib/openapi/schemas/credentials";
import { z } from "@/lib/openapi/zod";

const clientIdParam = PublicClientIdPathParamSchema;
const externalUserIdParam = ExternalUserIdParamSchema;

defineRoute({
  method: "post",
  path: "/api/v1/apps/{clientId}/auth/api-key/token",
  tags: ["Credentials"],
  summary: "Exchange API key for user access token",
  description:
    "RFC 6750 bearer exchange: long-lived `pmth_*` per-app-user API key → short-lived user JWT " +
    "(subject token for RFC 8693 signer exchange). Rejects `pmth_cs_*` M2M client secrets.",
  security: [{ bearerApiKey: [] }],
  request: {
    params: z.object({ clientId: clientIdParam }),
    body: {
      content: {
        "application/json": { schema: ApiKeyTokenRequestBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "User access token (subject token for signer exchange).",
      content: {
        "application/json": { schema: ProgrammaticTokenResponseSchema },
      },
    },
    400: {
      description: "Invalid request (including client secret presented as API key).",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    401: {
      description: "Missing or invalid API key.",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    404: {
      description: "App not found.",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/apps/{clientId}/auth/api-key/signer-session",
  tags: ["Credentials"],
  summary: "Exchange API key for signer session (canonical)",
  description:
    "Single-call path: `pmth_*` API key → signer JWT via internal user-token mint and " +
    "RFC 8693-equivalent exchange. Preferred over dashboard BFF `/api/pymthouse/keys/exchange`.",
  security: [{ bearerApiKey: [] }],
  request: {
    params: z.object({ clientId: clientIdParam }),
    body: {
      content: {
        "application/json": { schema: ApiKeySignerSessionRequestBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Canonical SignerSession envelope.",
      content: { "application/json": { schema: SignerSessionSchema } },
    },
    400: {
      description: "Invalid request.",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    401: {
      description: "Missing or invalid API key.",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
    404: {
      description: "App not found.",
      content: { "application/json": { schema: OAuthErrorResponseSchema } },
    },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/apps/{clientId}/users/{externalUserId}/token",
  tags: ["Credentials"],
  summary: "Mint programmatic user JWT (M2M)",
  description:
    "Confidential client (`m2m_*` + secret) mints a user-scoped access token. " +
    "Subject-token acquisition strategy for RFC 8693 signer exchange.",
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

defineRoute({
  method: "post",
  path: "/api/pymthouse/keys/exchange",
  tags: ["Credentials"],
  summary: "Facade API-key → signer session (dashboard BFF)",
  description:
    "Integrator-hosted facade route (not served by pymthouse core). Documented for SDK " +
    "compatibility. Response MUST match SignerSession. Prefer pymthouse " +
    "`/api/v1/apps/{clientId}/auth/api-key/signer-session` for direct issuer access.",
  request: {
    body: {
      content: {
        "application/json": { schema: FacadeApiKeyExchangeRequestBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "SignerSession envelope.",
      content: { "application/json": { schema: SignerSessionSchema } },
    },
    400: {
      description: "Invalid request.",
      content: { "application/json": { schema: OAuthErrorSchema } },
    },
    401: {
      description: "Exchange failed.",
      content: { "application/json": { schema: OAuthErrorSchema } },
    },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/oidc/token",
  tags: ["OIDC"],
  summary: "OIDC token endpoint (RFC 8693 signer exchange)",
  description:
    "Served by oidc-provider. Use OpenID Configuration for full parameter matrix. " +
    "Signer JWT exchange: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` with " +
    "`subject_token` from user JWT mint routes above.",
  skipCompletenessCheck: true,
  responses: {
    200: { description: "Token response per OAuth/OIDC." },
    400: { description: "OAuth error." },
  },
});
