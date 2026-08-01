import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import {
  builderErrorResponses,
  jsonSuccess,
  usageDateRangeQueryParams,
} from "@/lib/openapi/routes/shared";
import { OPENAPI_TAGS } from "@/lib/openapi/tags";
import { z } from "@/lib/openapi/zod";

const endUserSecurity: Array<Record<string, string[]>> = [{ endUserBearer: [] }];

const clientId = z
  .string()
  .min(1)
  .openapi({
    param: { name: "clientId", in: "path" },
    description: "Public OIDC client id (`app_…`).",
  });

const endUserUsageQueryParams = z.object({
  ...usageDateRangeQueryParams,
  groupBy: z
    .enum(["none", "user", "pipeline_model", "daily_pipeline", "manifest"])
    .optional()
    .openapi({
      param: { name: "groupBy", in: "query" },
      description:
        "Aggregation mode (default none). Subject is always the Bearer user; do not pass `userId`.",
    }),
});

const meUsagePath = (suffix: string) =>
  `/api/v1/apps/{clientId}/me/usage${suffix}`;

defineRouteMetadata("get", meUsagePath(""), {
  tags: [OPENAPI_TAGS.endUserUsage],
  summary: "End-user usage summary",
  description:
    "Aggregated usage for the authenticated subject on this app. " +
    "Do not pass `userId` / `externalUserId` — identity is taken from the Bearer credential. " +
    "Path `{clientId}` must match the credential’s public app. " +
    "Optional query: `startDate`, `endDate`, `groupBy`, `include` / `includeRetail`.",
  security: endUserSecurity,
  request: {
    params: z.object({ clientId }),
    query: endUserUsageQueryParams,
  },
  responses: {
    200: jsonSuccess,
    ...builderErrorResponses,
    503: { description: "OpenMeter not configured" },
  },
});

defineRouteMetadata("get", meUsagePath("/balance"), {
  tags: [OPENAPI_TAGS.endUserUsage],
  summary: "End-user usage balance",
  description:
    "Plan included-usage allowance for the authenticated subject " +
    "(`balanceUsdMicros` / `remainingUsdMicros` = remaining plan discount). " +
    "Prepaid credits settle invoices/charges and are not the meter source. " +
    "`userId` / `externalUserId` query overrides are rejected.",
  security: endUserSecurity,
  request: { params: z.object({ clientId }) },
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

defineRouteMetadata("get", meUsagePath("/requests"), {
  tags: [OPENAPI_TAGS.endUserUsage],
  summary: "End-user signed-ticket request history",
  description:
    "Chronological signed-ticket history for the authenticated subject. " +
    "`groupBy=session` lists per-manifest sessions; `groupBy=request` (default) " +
    "lists CloudEvents (optionally filtered by `manifestId`). " +
    "Do not pass `userId` / `externalUserId`.",
  security: endUserSecurity,
  request: {
    params: z.object({ clientId }),
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

/**
 * Deprecated pathless aliases. Identical behavior, but the app is derived from
 * the Bearer credential instead of `{clientId}`.
 */
const legacyAlias = (
  suffix: string,
  summary: string,
  query?: typeof endUserUsageQueryParams,
) => {
  defineRouteMetadata("get", `/api/v1/user/usage${suffix}`, {
    tags: [OPENAPI_TAGS.endUserUsage],
    summary: `${summary} (deprecated)`,
    description:
      `Deprecated alias for \`GET ${meUsagePath(suffix)}\`. ` +
      "Behavior is identical; the app is resolved from the Bearer credential " +
      "instead of the path. Prefer the app-scoped route for new integrations.",
    deprecated: true,
    security: endUserSecurity,
    ...(query ? { request: { query } } : {}),
    responses: {
      200: jsonSuccess,
      ...builderErrorResponses,
      503: { description: "OpenMeter not configured" },
    },
  });
};

legacyAlias("", "End-user usage summary", endUserUsageQueryParams);
legacyAlias("/balance", "End-user usage balance");
legacyAlias("/requests", "End-user signed-ticket request history");
