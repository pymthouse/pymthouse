import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import {
  builderErrorResponses,
  jsonSuccess,
} from "@/lib/openapi/routes/shared";
import { OPENAPI_TAGS } from "@/lib/openapi/tags";
import { z } from "@/lib/openapi/zod";

const endUserSecurity: Array<Record<string, string[]>> = [{ endUserBearer: [] }];

const endUserUsageQueryParams = z.object({
  startDate: z
    .string()
    .optional()
    .openapi({
      param: { name: "startDate", in: "query" },
      description: "Inclusive lower bound (ISO 8601).",
    }),
  endDate: z
    .string()
    .optional()
    .openapi({
      param: { name: "endDate", in: "query" },
      description: "Inclusive upper bound (ISO 8601).",
    }),
  groupBy: z
    .enum(["none", "user", "pipeline_model", "daily_pipeline", "manifest"])
    .optional()
    .openapi({
      param: { name: "groupBy", in: "query" },
      description:
        "Aggregation mode (default none). Subject is always the Bearer user; do not pass `userId`.",
    }),
  include: z
    .literal("retail")
    .optional()
    .openapi({
      param: { name: "include", in: "query" },
      description: "Set to `retail` to include retail billable micros.",
    }),
  includeRetail: z
    .enum(["1", "true"])
    .optional()
    .openapi({
      param: { name: "includeRetail", in: "query" },
      description: "Alternate flag for retail breakdown (`1` or `true`).",
    }),
});

defineRouteMetadata("get", "/api/v1/user/usage", {
  tags: [OPENAPI_TAGS.endUserUsage],
  summary: "End-user usage summary",
  description:
    "Aggregated usage for the authenticated subject only. " +
    "Do not pass `userId` / `externalUserId` — identity is taken from the Bearer credential. " +
    "Optional query: `startDate`, `endDate`, `groupBy`, `include` / `includeRetail`.",
  security: endUserSecurity,
  request: { query: endUserUsageQueryParams },
  responses: {
    200: jsonSuccess,
    ...builderErrorResponses,
    503: { description: "OpenMeter not configured" },
  },
});

defineRouteMetadata("get", "/api/v1/user/usage/balance", {
  tags: [OPENAPI_TAGS.endUserUsage],
  summary: "End-user usage balance",
  description:
    "Plan included-usage allowance for the authenticated subject " +
    "(`balanceUsdMicros` / `remainingUsdMicros` = remaining plan discount). " +
    "Prepaid credits settle invoices/charges and are not the meter source. " +
    "`userId` / `externalUserId` query overrides are rejected.",
  security: endUserSecurity,
  responses: {
    200: jsonSuccess,
    ...builderErrorResponses,
    400: {
      ...builderErrorResponses[400],
      description: "Disallowed cross-user filter",
    },
    401: {
      ...builderErrorResponses[401],
      description: "Missing or invalid end-user credential",
    },
    503: { description: "OpenMeter not configured" },
  },
});

defineRouteMetadata("get", "/api/v1/user/usage/requests", {
  tags: [OPENAPI_TAGS.endUserUsage],
  summary: "End-user signed-ticket request history",
  description:
    "Chronological signed-ticket history for the authenticated subject. " +
    "`groupBy=session` lists per-manifest sessions; `groupBy=request` (default) " +
    "lists CloudEvents (optionally filtered by `manifestId`). " +
    "Do not pass `userId` / `externalUserId`.",
  security: endUserSecurity,
  request: {
    query: z.object({
      groupBy: z
        .enum(["request", "session"])
        .optional()
        .openapi({
          param: { name: "groupBy", in: "query" },
          description: "session or request (default request).",
        }),
      manifestId: z
        .string()
        .min(1)
        .optional()
        .openapi({
          param: { name: "manifestId", in: "query" },
          description:
            "When groupBy=request, restrict to one session manifest ID.",
        }),
      cursor: z
        .string()
        .min(1)
        .optional()
        .openapi({
          param: { name: "cursor", in: "query" },
          description: "Opaque pagination cursor from a prior response.",
        }),
      limit: z
        .coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .openapi({
          param: { name: "limit", in: "query" },
          description: "Page size (default 25, max 50).",
        }),
    }),
  },
  responses: {
    200: jsonSuccess,
    ...builderErrorResponses,
    400: {
      ...builderErrorResponses[400],
      description: "Disallowed cross-user filter or invalid groupBy",
    },
    401: {
      ...builderErrorResponses[401],
      description: "Missing or invalid end-user credential",
    },
    503: { description: "OpenMeter not configured" },
  },
});
