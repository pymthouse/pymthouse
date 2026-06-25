import { defineRoute } from "@/lib/openapi/registry";
import { OAuthErrorSchema } from "@/lib/openapi/schemas/common";
import {
  AdminTokenIssueRequestSchema,
  AdminTokenIssueResponseSchema,
  AdminTokenListResponseSchema,
  AdminTokenRevokeRequestSchema,
  C0ValidateRequestBodySchema,
  C0ValidateResponseSchema,
  HealthResponseSchema,
  LegacyValidateResponseSchema,
} from "@/lib/openapi/schemas/misc";
import { z } from "@/lib/openapi/zod";

const jsonObject = z.object({}).passthrough();

defineRoute({
  method: "get",
  path: "/api/v1/health",
  tags: ["Platform"],
  summary: "Health check",
  responses: {
    200: {
      description: "Service healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/auth/validate",
  tags: ["Credentials"],
  summary: "Validate API key (legacy GET)",
  deprecated: true,
  description:
    "Deprecated: Bearer validation for legacy BPP consumers. Prefer POST validate (C0) when enabled.",
  security: [{ bearerApiKey: [] }],
  responses: {
    200: {
      description: "Validation result",
      content: { "application/json": { schema: LegacyValidateResponseSchema } },
    },
    401: { description: "Invalid key" },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/auth/validate",
  tags: ["Credentials"],
  summary: "Validate API key (C0 POST)",
  description: "Provider-neutral validate when `BPP_VALIDATE_V2=1`.",
  request: {
    body: {
      content: { "application/json": { schema: C0ValidateRequestBodySchema } },
    },
  },
  responses: {
    200: {
      description: "C0 validate body",
      content: { "application/json": { schema: C0ValidateResponseSchema } },
    },
    400: { description: "Missing key" },
    401: { description: "Invalid key" },
    404: { description: "Feature disabled" },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/tokens",
  tags: ["Platform"],
  summary: "Issue admin/platform bearer token",
  security: [{ adminSession: [] }],
  request: {
    body: {
      content: { "application/json": { schema: AdminTokenIssueRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Issued token",
      content: { "application/json": { schema: AdminTokenIssueResponseSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/tokens",
  tags: ["Platform"],
  summary: "List admin/platform tokens",
  security: [{ adminSession: [] }],
  responses: {
    200: {
      description: "Token list",
      content: { "application/json": { schema: AdminTokenListResponseSchema } },
    },
  },
});

defineRoute({
  method: "delete",
  path: "/api/v1/tokens",
  tags: ["Platform"],
  summary: "Revoke admin/platform token",
  security: [{ adminSession: [] }],
  request: {
    body: {
      content: { "application/json": { schema: AdminTokenRevokeRequestSchema } },
    },
  },
  responses: {
    200: { description: "Revoked" },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/ingest/events",
  tags: ["Usage"],
  summary: "Ingest signed ticket events",
  description: "Public alias of `/api/v1/internal/ingest/signed-ticket`.",
  responses: {
    202: { description: "Accepted" },
    401: { description: "Unauthorized", content: { "application/json": { schema: OAuthErrorSchema } } },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/marketplace",
  tags: ["Marketplace"],
  summary: "List marketplace apps",
  responses: {
    200: { description: "Marketplace catalog", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/marketplace/{id}",
  tags: ["Marketplace"],
  summary: "Get marketplace app",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" } }),
    }),
  },
  responses: {
    200: { description: "Marketplace entry", content: { "application/json": { schema: jsonObject } } },
    404: { description: "Not found" },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/pipeline-catalog",
  tags: ["Discovery"],
  summary: "Pipeline capability catalog",
  responses: {
    200: { description: "Catalog", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/pipeline-pricing",
  tags: ["Discovery"],
  summary: "Pipeline pricing table",
  responses: {
    200: { description: "Pricing", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/openapi.json",
  tags: ["Platform"],
  summary: "OpenAPI document",
  responses: {
    200: { description: "OpenAPI 3.1 JSON" },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/docs",
  tags: ["Platform"],
  summary: "Interactive API reference (Scalar)",
  responses: {
    200: { description: "HTML API reference" },
  },
});
