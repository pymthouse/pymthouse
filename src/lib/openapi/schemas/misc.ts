import { z } from "@/lib/openapi/zod";
import { CorrelationIdSchema } from "./common";

export const C0ValidateRequestBodySchema = z
  .object({
    key: z.string().trim().min(1),
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

export const HealthResponseSchema = z
  .object({
    status: z.string(),
    correlation_id: CorrelationIdSchema.optional(),
  })
  .openapi("HealthResponse");
