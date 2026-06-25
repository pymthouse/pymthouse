import { z } from "@/lib/openapi/zod";
import { CorrelationIdSchema } from "./common";

export const LegacyValidateResponseSchema = z
  .object({
    valid: z.boolean(),
    client_id: z.string().optional(),
    plan: z.unknown().nullable().optional(),
    allowedModels: z.array(z.string()).optional(),
    subscriptionRef: z.string().optional(),
  })
  .openapi("LegacyValidateResponse");

export const C0ValidateRequestBodySchema = z
  .object({
    key: z.string().min(1),
  })
  .openapi("C0ValidateRequest");

export const C0ValidateResponseSchema = z
  .object({
    valid: z.boolean(),
    user: z.object({ sub: z.string() }).optional(),
    billing_account: z
      .object({
        id: z.string(),
        providerSlug: z.string(),
        billingMode: z.enum(["delegated", "prepay"]),
      })
      .optional(),
    capabilities: z.array(z.string()).optional(),
    quota: z.unknown().nullable().optional(),
    subscriptionRef: z.string().optional(),
  })
  .openapi("C0ValidateResponse");

export const AdminTokenIssueRequestSchema = z
  .object({
    scopes: z.string().optional(),
    expiresInDays: z.number().int().positive().optional(),
    endUserId: z.string().optional(),
    label: z.string().optional(),
  })
  .openapi("AdminTokenIssueRequest");

export const AdminTokenIssueResponseSchema = z
  .object({
    sessionId: z.string(),
    token: z.string(),
    scopes: z.string(),
    endUserId: z.string().nullable(),
    expiresInDays: z.number(),
    message: z.string(),
  })
  .openapi("AdminTokenIssueResponse");

export const AdminTokenListResponseSchema = z
  .object({
    tokens: z.array(
      z.object({
        id: z.string(),
        label: z.string().nullable(),
        endUserId: z.string().nullable(),
        scopes: z.string(),
        expiresAt: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  })
  .openapi("AdminTokenListResponse");

export const AdminTokenRevokeRequestSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .openapi("AdminTokenRevokeRequest");

export const HealthResponseSchema = z
  .object({
    status: z.string(),
    correlation_id: CorrelationIdSchema.optional(),
  })
  .openapi("HealthResponse");
