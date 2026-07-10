import { z } from "@/lib/openapi/zod";
import {
  CorrelationIdSchema,
  ScopeStringSchema,
} from "./common";

/**
 * Per-app-user API keys (`pmth_<hex>`). Not M2M client secrets (`pmth_cs_<hex>`).
 */
export const AppApiKeyBearerSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.startsWith("pmth_cs_"), {
    message:
      "pmth_cs_* is an M2M client secret (RFC 6749 client authentication). " +
      "Use HTTP Basic with the m2m_* client id, or pass the API key as subject_token " +
      "to POST /api/v1/apps/{clientId}/oidc/token.",
  })
  .refine((value) => value.startsWith("pmth_"), {
    message: "API key must start with pmth_ (per-user app API key).",
  })
  .openapi({
    description:
      "Long-lived per-app-user API key (`pmth_<hex>`). Rejects `pmth_cs_*` client secrets.",
    examples: ["pmth_abc123…"],
  });

export const ProgrammaticTokenResponseSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().positive(),
    scope: ScopeStringSchema,
    subject_type: z.literal("app_user").optional(),
    externalUserId: z.string().optional(),
    correlation_id: CorrelationIdSchema.optional(),
  })
  .openapi("ProgrammaticTokenResponse");

export const ProgrammaticUserTokenRequestBodySchema = z
  .object({
    scope: ScopeStringSchema.optional(),
  })
  .openapi("ProgrammaticUserTokenRequest");

/**
 * Canonical signer session envelope (RFC 8693 token-exchange output + signer routing).
 * Flat OAuth-style fields are authoritative.
 */
export const SignerSessionSchema = z
  .object({
    access_token: z.string().openapi({ description: "Short-lived signer JWT (RFC 8693)." }),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().positive(),
    scope: ScopeStringSchema,
    balanceUsdMicros: z.string().optional().openapi({
      description: "PymtHouse extension: remaining balance in USD micros.",
    }),
    lifetimeGrantedUsdMicros: z.string().optional().openapi({
      description: "PymtHouse extension: lifetime granted balance in USD micros.",
    }),
    signer_url: z.string().url().optional().openapi({
      description: "Public remote-signer base URL.",
    }),
    discovery_url: z.string().url().optional().openapi({
      description: "Livepeer network discovery URL (not OIDC issuer metadata).",
    }),
    issued_token_type: z
      .literal("urn:ietf:params:oauth:token-type:access_token")
      .optional()
      .openapi({ description: "RFC 8693 issued_token_type when sourced from /token." }),
    correlation_id: CorrelationIdSchema.optional(),
  })
  .openapi("SignerSession");

export const TokenExchangeRequestSchema = z
  .object({
    grant_type: z
      .literal("urn:ietf:params:oauth:grant-type:token-exchange")
      .openapi({ description: "RFC 8693 token exchange grant type." }),
    subject_token: z.string().openapi({
      description: "User access JWT or per-app-user API key (`pmth_*`).",
    }),
    subject_token_type: z
      .literal("urn:ietf:params:oauth:token-type:access_token")
      .openapi({ description: "Subject token type for signer session exchange." }),
    requested_token_type: z
      .literal("urn:ietf:params:oauth:token-type:access_token")
      .optional(),
    audience: z.string().optional().openapi({
      description: "Must match configured signer audience when provided.",
    }),
    resource: z.string().optional().openapi({
      description: "Must match configured signer audience when provided.",
    }),
  })
  .openapi("TokenExchangeRequest");

export { OAuthErrorSchema as OAuthErrorResponseSchema } from "./common";
