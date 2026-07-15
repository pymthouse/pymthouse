import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import {
  builderErrorResponses,
  jsonSuccess,
} from "@/lib/openapi/routes/shared";
import { OPENAPI_TAGS } from "@/lib/openapi/tags";

const endUserSecurity: Array<Record<string, string[]>> = [{ endUserBearer: [] }];

defineRouteMetadata("get", "/api/v1/user/usage", {
  tags: [OPENAPI_TAGS.endUserUsage],
  summary: "End-user usage summary",
  description:
    "Aggregated usage for the authenticated subject only. " +
    "Do not pass `externalUserId` — identity is taken from the Bearer credential. " +
    "Supports the same `groupBy` / date query params as Builder usage.",
  security: endUserSecurity,
  responses: {
    200: jsonSuccess,
    503: { description: "OpenMeter not configured" },
    ...builderErrorResponses,
  },
});

defineRouteMetadata("get", "/api/v1/user/usage/balance", {
  tags: [OPENAPI_TAGS.endUserUsage],
  summary: "End-user usage balance",
  description:
    "Prepaid / trial credit balance for the authenticated subject. " +
    "`externalUserId` query overrides are rejected.",
  security: endUserSecurity,
  responses: {
    200: jsonSuccess,
    400: { description: "Disallowed cross-user filter" },
    401: { description: "Missing or invalid end-user credential" },
    503: { description: "OpenMeter not configured" },
  },
});

defineRouteMetadata("get", "/api/v1/user/usage/requests", {
  tags: [OPENAPI_TAGS.endUserUsage],
  summary: "End-user signed-ticket request history",
  description:
    "Chronological `create_signed_ticket` events for the authenticated subject. " +
    "Query: `cursor`, `limit` (max 50). Do not pass `externalUserId`.",
  security: endUserSecurity,
  responses: {
    200: jsonSuccess,
    400: { description: "Disallowed cross-user filter" },
    401: { description: "Missing or invalid end-user credential" },
  },
});
