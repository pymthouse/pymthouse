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

const endUserRequestsQueryParams = z.object({
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
  from: z
    .string()
    .optional()
    .openapi({
      param: { name: "from", in: "query" },
      description:
        "Inclusive lower bound (ISO 8601). Must be paired with `to`. Console uses the last 7 days.",
    }),
  to: z
    .string()
    .optional()
    .openapi({
      param: { name: "to", in: "query" },
      description: "Inclusive upper bound (ISO 8601). Must be paired with `from`.",
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
    "Optional `from`/`to` (ISO 8601, together) override the default calendar-month window. " +
    "Do not pass `userId` / `externalUserId`.",
  security: endUserSecurity,
  request: {
    params: z.object({ clientId }),
    query: endUserRequestsQueryParams,
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
 * Pathless end-user usage. App is resolved from the Bearer credential
 * (`pmth_*`, optional composite, or user/signer JWT).
 */
const defineUserUsageRoute = (
  suffix: string,
  summary: string,
  query?: typeof endUserUsageQueryParams | typeof endUserRequestsQueryParams,
) => {
  defineRouteMetadata("get", `/api/v1/user/usage${suffix}`, {
    tags: [OPENAPI_TAGS.endUserUsage],
    summary,
    description:
      "Usage for the authenticated subject. The app is resolved from the " +
      "Bearer credential (bare `pmth_*` key, optional composite, or user/signer JWT). " +
      "Do not pass `userId` / `externalUserId`. " +
      `App-scoped equivalent: \`GET ${meUsagePath(suffix)}\`.`,
    security: endUserSecurity,
    ...(query ? { request: { query } } : {}),
    responses: {
      200: jsonSuccess,
      ...builderErrorResponses,
      503: { description: "OpenMeter not configured" },
    },
  });
};

defineUserUsageRoute("", "End-user usage summary", endUserUsageQueryParams);
defineUserUsageRoute("/balance", "End-user usage balance");
defineUserUsageRoute(
  "/requests",
  "End-user signed-ticket request history",
  endUserRequestsQueryParams,
);
