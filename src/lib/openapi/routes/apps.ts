import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import {
  PublicClientIdPathParamSchema,
  ExternalUserIdParamSchema,
} from "@/lib/openapi/schemas/common";
import {
  builderErrorResponses,
  genericJsonObject,
  jsonSuccess,
} from "@/lib/openapi/routes/shared";
import { OPENAPI_TAGS } from "@/lib/openapi/tags";
import { z } from "@/lib/openapi/zod";

const clientId = PublicClientIdPathParamSchema;
const externalUserId = ExternalUserIdParamSchema;

function appPath(suffix: string) {
  return `/api/v1/apps/{clientId}${suffix}`;
}

function builderAppPath(suffix: string) {
  return `/api/v1/builder/apps/{clientId}${suffix}`;
}

function userPath(suffix: string) {
  return `/api/v1/apps/{clientId}/users/{externalUserId}${suffix}`;
}

const m2mSecurity: Array<Record<string, string[]>> = [{ m2mBasic: [] }, { bearerUserJwt: [] }];
const m2mOnlySecurity: Array<Record<string, string[]>> = [{ m2mBasic: [] }];

/**
 * Builder (M2M) OpenAPI metadata only.
 * Dashboard/Internal app CRUD (admins, domains, settings, create/delete app, …)
 * is intentionally not registered here.
 */

defineRouteMetadata("get", appPath(""), {
  tags: [OPENAPI_TAGS.app],
  summary: "Get app (integrator view)",
  description: "Returns the app record visible to the authenticated M2M client.",
  security: m2mOnlySecurity,
  request: { params: z.object({ clientId }) },
  responses: {
    200: { description: "App", content: { "application/json": { schema: genericJsonObject } } },
    ...builderErrorResponses,
  },
});

// Users
defineRouteMetadata("get", appPath("/users"), {
  tags: [OPENAPI_TAGS.users],
  summary: "List provisioned users",
  security: m2mSecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("post", appPath("/users"), {
  tags: [OPENAPI_TAGS.users],
  summary: "Upsert provisioned user",
  security: m2mSecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("put", appPath("/users"), {
  tags: [OPENAPI_TAGS.users],
  summary: "Update provisioned user",
  security: m2mSecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("delete", appPath("/users"), {
  tags: [OPENAPI_TAGS.users],
  summary: "Deactivate provisioned user",
  security: m2mSecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});

defineRouteMetadata("get", userPath("/keys"), {
  tags: [OPENAPI_TAGS.users],
  summary: "List user API keys",
  security: m2mSecurity,
  request: { params: z.object({ clientId, externalUserId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("post", userPath("/keys"), {
  tags: [OPENAPI_TAGS.users],
  summary: "Create user API key",
  security: m2mSecurity,
  request: { params: z.object({ clientId, externalUserId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("delete", userPath("/keys"), {
  tags: [OPENAPI_TAGS.users],
  summary: "Revoke user API key",
  security: m2mSecurity,
  request: { params: z.object({ clientId, externalUserId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});

defineRouteMetadata("get", userPath("/allowances"), {
  tags: [OPENAPI_TAGS.users],
  summary: "List user allowances",
  security: m2mSecurity,
  request: { params: z.object({ clientId, externalUserId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("post", userPath("/allowances"), {
  tags: [OPENAPI_TAGS.users],
  summary: "Grant user allowance",
  security: m2mSecurity,
  request: { params: z.object({ clientId, externalUserId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("get", userPath("/subscription"), {
  tags: [OPENAPI_TAGS.users],
  summary: "Get user subscription",
  security: m2mSecurity,
  request: { params: z.object({ clientId, externalUserId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});

// Usage (canonical Builder mount)
defineRouteMetadata("get", builderAppPath("/usage"), {
  tags: [OPENAPI_TAGS.usage],
  summary: "Usage summary",
  description: "M2M Basic only.",
  security: m2mOnlySecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("get", builderAppPath("/usage/balance"), {
  tags: [OPENAPI_TAGS.usage],
  summary: "Usage balance",
  description: "M2M Basic only. Query `externalUserId` for one end user.",
  security: m2mOnlySecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});

// Billing / discovery reads
defineRouteMetadata("get", appPath("/billing"), {
  tags: [OPENAPI_TAGS.billing],
  summary: "Billing profile",
  security: m2mSecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("post", appPath("/billing/checkout"), {
  tags: [OPENAPI_TAGS.billing],
  summary: "Create billing checkout",
  security: m2mSecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("get", appPath("/plans"), {
  tags: [OPENAPI_TAGS.billing],
  summary: "List plans",
  security: m2mSecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});

defineRouteMetadata("get", appPath("/discovery-profiles"), {
  tags: [OPENAPI_TAGS.discovery],
  summary: "List discovery profiles",
  security: m2mSecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("get", "/api/v1/apps/{clientId}/discovery-profiles/{profileId}", {
  tags: [OPENAPI_TAGS.discovery],
  summary: "Get discovery profile",
  security: m2mSecurity,
  request: {
    params: z.object({
      clientId,
      profileId: z.string().openapi({ param: { name: "profileId", in: "path" } }),
    }),
  },
  responses: {
    200: jsonSuccess,
    404: { description: "Not found" },
  },
});
defineRouteMetadata("get", appPath("/manifest"), {
  tags: [OPENAPI_TAGS.discovery],
  summary: "App manifest",
  security: m2mSecurity,
  request: { params: z.object({ clientId }) },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
