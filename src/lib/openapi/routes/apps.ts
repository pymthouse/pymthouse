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

type MetadataRoute = [
  method: "get" | "post" | "put" | "delete",
  path: string,
  tag: string,
  summary: string,
  options?: {
    includeExternalUserId?: boolean;
    /** Also document 201 Created (upsert/create handlers). */
    created?: boolean;
  },
];

function registerMetadataRoutes(routes: MetadataRoute[]): void {
  for (const [method, path, tag, summary, options] of routes) {
    defineRouteMetadata(method, path, {
      tags: [tag],
      summary,
      security: m2mSecurity,
      request: {
        params: options?.includeExternalUserId
          ? z.object({ clientId, externalUserId })
          : z.object({ clientId }),
      },
      responses: {
        200: jsonSuccess,
        ...(options?.created
          ? {
              201: {
                description: "Created",
                content: jsonSuccess.content,
              },
            }
          : {}),
        ...builderErrorResponses,
      },
    });
  }
}

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

registerMetadataRoutes([
  ["get", appPath("/users"), OPENAPI_TAGS.users, "List provisioned users"],
  ["post", appPath("/users"), OPENAPI_TAGS.users, "Upsert provisioned user", { created: true }],
  ["put", appPath("/users"), OPENAPI_TAGS.users, "Update provisioned user"],
  ["delete", appPath("/users"), OPENAPI_TAGS.users, "Deactivate provisioned user"],
  ["get", userPath("/keys"), OPENAPI_TAGS.users, "List user API keys", { includeExternalUserId: true }],
  [
    "post",
    userPath("/keys"),
    OPENAPI_TAGS.users,
    "Create user API key",
    { includeExternalUserId: true, created: true },
  ],
  ["delete", userPath("/keys"), OPENAPI_TAGS.users, "Revoke user API key", { includeExternalUserId: true }],
  ["get", userPath("/allowances"), OPENAPI_TAGS.users, "List user allowances", { includeExternalUserId: true }],
  ["post", userPath("/allowances"), OPENAPI_TAGS.users, "Grant user allowance", { includeExternalUserId: true }],
  ["get", userPath("/subscription"), OPENAPI_TAGS.users, "Get user subscription", { includeExternalUserId: true }],
]);

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
  description: "M2M Basic only. Requires `externalUserId` for one end user.",
  security: m2mOnlySecurity,
  request: {
    params: z.object({ clientId }),
    query: z.object({
      externalUserId: z
        .string()
        .min(1)
        .openapi({
          param: { name: "externalUserId", in: "query" },
          description: "Integrator-defined stable user id.",
        }),
    }),
  },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});

registerMetadataRoutes([
  ["get", appPath("/billing"), OPENAPI_TAGS.billing, "Billing profile"],
  ["post", appPath("/billing/checkout"), OPENAPI_TAGS.billing, "Create billing checkout"],
  ["get", appPath("/plans"), OPENAPI_TAGS.billing, "List plans"],
  ["get", appPath("/discovery-profiles"), OPENAPI_TAGS.discovery, "List discovery profiles"],
]);

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

registerMetadataRoutes([
  ["get", appPath("/manifest"), OPENAPI_TAGS.discovery, "App manifest"],
]);
