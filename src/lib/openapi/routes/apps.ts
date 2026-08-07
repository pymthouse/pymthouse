import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import {
  PublicClientIdPathParamSchema,
  ExternalUserIdParamSchema,
} from "@/lib/openapi/schemas/common";
import {
  builderErrorResponses,
  genericJsonObject,
  jsonSuccess,
  usageDateRangeQueryParams,
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

const m2mSecurity: Array<Record<string, string[]>> = [{ m2mBasic: [] }];

const ownerBillingConfirmBody = z
  .object({
    confirm: z.literal(true).openapi({
      description: "Must be true to perform the mutation.",
    }),
  })
  .openapi("OwnerBillingConfirmBody");

const ownerBillingSubscriptionPutBody = z
  .object({
    planKey: z.string().min(1).openapi({
      description: "Owner Paid plan key to upgrade or switch to.",
    }),
    confirm: z.literal(true).openapi({
      description: "Must be true to perform the mutation.",
    }),
  })
  .openapi("OwnerBillingSubscriptionPutBody");

const ownerPaymentMethodSetupBody = z
  .object({
    successUrl: z.url().optional(),
    cancelUrl: z.url().optional(),
  })
  .openapi("OwnerPaymentMethodSetupBody");

const ownerPaymentMethodIdBody = z
  .object({
    paymentMethodId: z.string().min(1).openapi({
      description:
        "Stripe payment method id. Also accepted as query `id` on PATCH/DELETE.",
    }),
  })
  .openapi("OwnerPaymentMethodIdBody");

type MetadataRoute = [
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  tag: string,
  summary: string,
  options?: {
    includeExternalUserId?: boolean;
    /** Also document 201 Created (upsert/create handlers). */
    created?: boolean;
    body?: z.ZodTypeAny;
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
        ...(options?.body
          ? {
              body: {
                content: {
                  "application/json": { schema: options.body },
                },
              },
            }
          : {}),
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
  security: m2mSecurity,
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
  [
    "get",
    userPath("/invoices"),
    OPENAPI_TAGS.billing,
    "List end-user invoices",
    { includeExternalUserId: true },
  ],
  [
    "get",
    userPath("/payment-methods"),
    OPENAPI_TAGS.billing,
    "List end-user payment methods",
    { includeExternalUserId: true },
  ],
  [
    "post",
    userPath("/payment-methods"),
    OPENAPI_TAGS.billing,
    "Start end-user payment-method setup",
    { includeExternalUserId: true, body: ownerPaymentMethodSetupBody },
  ],
]);

defineRouteMetadata("get", userPath("/invoices/{invoiceId}/hosted-url"), {
  tags: [OPENAPI_TAGS.billing],
  summary: "Get end-user invoice hosted URL",
  security: m2mSecurity,
  request: {
    params: z.object({
      clientId,
      externalUserId,
      invoiceId: z.string().min(1).openapi({
        param: { name: "invoiceId", in: "path" },
        description: "OpenMeter invoice id.",
      }),
    }),
  },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});

const usageQueryParams = z.object({
  ...usageDateRangeQueryParams,
  groupBy: z
    .enum(["none", "user", "pipeline_model", "daily_pipeline", "manifest"])
    .optional()
    .openapi({
      param: { name: "groupBy", in: "query" },
      description:
        "Aggregation mode (default none). `daily_pipeline` requires `userId`.",
    }),
  userId: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "userId", in: "query" },
      description: "Filter to one usage subject / internal user id.",
    }),
});

// Usage (canonical Builder mount)
defineRouteMetadata("get", builderAppPath("/usage"), {
  tags: [OPENAPI_TAGS.usage],
  summary: "Usage summary",
  description:
    "M2M Basic only. Optional `startDate` / `endDate` / `groupBy` / `userId` / retail include flags.",
  security: m2mSecurity,
  request: {
    params: z.object({ clientId }),
    query: usageQueryParams,
  },
  responses: { 200: jsonSuccess, ...builderErrorResponses },
});
defineRouteMetadata("get", builderAppPath("/usage/balance"), {
  tags: [OPENAPI_TAGS.usage],
  summary: "Usage balance",
  description:
    "M2M Basic only. Requires `externalUserId`. Returns plan included-usage " +
    "allowance for that end user (not prepaid ledger fields).",
  security: m2mSecurity,
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
  [
    "get",
    appPath("/billing/tiers"),
    OPENAPI_TAGS.billing,
    "List Owner Paid tiers",
  ],
  [
    "get",
    appPath("/billing/subscription"),
    OPENAPI_TAGS.billing,
    "Owner subscription switching status",
  ],
  [
    "put",
    appPath("/billing/subscription"),
    OPENAPI_TAGS.billing,
    "Upgrade or change Owner Paid plan",
    { body: ownerBillingSubscriptionPutBody },
  ],
  [
    "delete",
    appPath("/billing/subscription"),
    OPENAPI_TAGS.billing,
    "Schedule Starter downgrade",
    { body: ownerBillingConfirmBody },
  ],
  [
    "delete",
    appPath("/billing/subscription/pending-change"),
    OPENAPI_TAGS.billing,
    "Cancel pending Starter downgrade",
    { body: ownerBillingConfirmBody },
  ],
  [
    "get",
    appPath("/billing/payment-methods"),
    OPENAPI_TAGS.billing,
    "List owner payment methods",
  ],
  [
    "post",
    appPath("/billing/payment-methods"),
    OPENAPI_TAGS.billing,
    "Start owner payment-method setup",
    { body: ownerPaymentMethodSetupBody },
  ],
  [
    "patch",
    appPath("/billing/payment-methods"),
    OPENAPI_TAGS.billing,
    "Set default owner payment method",
    { body: ownerPaymentMethodIdBody },
  ],
  [
    "delete",
    appPath("/billing/payment-methods"),
    OPENAPI_TAGS.billing,
    "Unlink owner payment method",
    { body: ownerPaymentMethodIdBody },
  ],
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
