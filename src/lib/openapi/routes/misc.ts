import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import { OAuthErrorSchema } from "@/lib/openapi/schemas/common";
import {
  AdminTokenIssueRequestSchema,
  AdminTokenIssueResponseSchema,
  AdminTokenListResponseSchema,
  AdminTokenRevokeRequestSchema,
  C0ValidateRequestBodySchema,
  C0ValidateResponseSchema,
  HealthResponseSchema,
} from "@/lib/openapi/schemas/misc";
import { z } from "@/lib/openapi/zod";

const jsonObject = z.object({}).passthrough();

defineRouteMetadata("get", "/api/v1/health", {
  tags: ["Platform"],
  summary: "Health check",
  responses: {
    200: {
      description: "Service healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

defineRouteMetadata("post", "/api/v1/auth/validate", {
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

defineRouteMetadata("post", "/api/v1/tokens", {
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

defineRouteMetadata("get", "/api/v1/tokens", {
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

defineRouteMetadata("delete", "/api/v1/tokens", {
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

defineRouteMetadata("post", "/api/v1/ingest/events", {
  tags: ["Usage"],
  summary: "Ingest signed ticket events",
  description: "Public alias of `/api/v1/internal/ingest/signed-ticket`.",
  responses: {
    202: { description: "Accepted" },
    401: { description: "Unauthorized", content: { "application/json": { schema: OAuthErrorSchema } } },
  },
});

defineRouteMetadata("get", "/api/v1/marketplace", {
  tags: ["Marketplace"],
  summary: "List marketplace apps",
  responses: {
    200: { description: "Marketplace catalog", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRouteMetadata("get", "/api/v1/marketplace/{id}", {
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

defineRouteMetadata("get", "/api/v1/pipeline-catalog", {
  tags: ["Discovery"],
  summary: "Pipeline capability catalog",
  responses: {
    200: { description: "Catalog", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRouteMetadata("get", "/api/v1/pipeline-pricing", {
  tags: ["Discovery"],
  summary: "Pipeline pricing table",
  responses: {
    200: { description: "Pricing", content: { "application/json": { schema: jsonObject } } },
  },
});
