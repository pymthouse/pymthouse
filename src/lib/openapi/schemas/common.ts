import { z } from "@/lib/openapi/zod";

export const CorrelationIdSchema = z
  .string()
  .uuid()
  .openapi({ description: "Request correlation id for support and audit." });

export const OAuthErrorSchema = z
  .object({
    error: z.string().openapi({
      description: "OAuth 2.0 error code (RFC 6749 §5.2).",
      examples: ["invalid_request", "invalid_client", "invalid_scope"],
    }),
    error_description: z.string().optional().openapi({
      description: "Human-readable error description.",
    }),
    correlation_id: CorrelationIdSchema.optional(),
  })
  .openapi("OAuthError");

export const ScopeStringSchema = z
  .string()
  .trim()
  .min(1)
  .openapi({
    description: "Space-delimited OAuth scopes.",
    examples: ["sign:job"],
  });

export const PublicClientIdSchema = z
  .string()
  .regex(/^app_[a-f0-9]+$/)
  .openapi({
    description: "Public Builder app client id (`app_…`).",
    examples: ["app_3b386c81a1db1169fd2c3986"],
  });

export const PublicClientIdPathParamSchema = PublicClientIdSchema.openapi({
  param: { name: "clientId", in: "path" },
});

export const ExternalUserIdParamSchema = z
  .string()
  .min(1)
  .openapi({
    param: { name: "externalUserId", in: "path" },
    description: "Integrator-defined stable user id.",
  });
