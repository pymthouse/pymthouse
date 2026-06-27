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
import { z } from "@/lib/openapi/zod";

const clientId = PublicClientIdPathParamSchema;
const externalUserId = ExternalUserIdParamSchema;

function appPath(suffix: string) {
  return `/api/v1/apps/{clientId}${suffix}`;
}

function userPath(suffix: string) {
  return `/api/v1/apps/{clientId}/users/{externalUserId}${suffix}`;
}

type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

const m2mSecurity: Array<Record<string, string[]>> = [{ m2mBasic: [] }, { bearerUserJwt: [] }];
const adminSecurity: Array<Record<string, string[]>> = [{ adminSession: [] }];

function registerAppMetadata(
  method: HttpMethod,
  suffix: string,
  summary: string,
  options?: { description?: string; tags?: string[]; security?: Array<Record<string, string[]>>; status?: 200 | 201 | 204 },
) {
  const status = options?.status ?? 200;
  defineRouteMetadata(method, appPath(suffix), {
    tags: options?.tags ?? ["Apps"],
    summary,
    description: options?.description,
    security: options?.security ?? m2mSecurity,
    request: {
      params: z.object({ clientId }),
    },
    responses: {
      [status]: status === 204 ? { description: "Success" } : jsonSuccess,
      ...builderErrorResponses,
    },
  });
}

function registerUserMetadata(
  method: HttpMethod,
  suffix: string,
  summary: string,
  options?: { description?: string; tags?: string[] },
) {
  defineRouteMetadata(method, userPath(suffix), {
    tags: options?.tags ?? ["Users"],
    summary,
    description: options?.description,
    security: m2mSecurity,
    request: {
      params: z.object({ clientId, externalUserId }),
    },
    responses: {
      200: jsonSuccess,
      ...builderErrorResponses,
    },
  });
}

// Apps catalog
defineRouteMetadata("get", "/api/v1/apps", {
  tags: ["Apps"],
  summary: "List developer apps",
  security: adminSecurity,
  responses: {
    200: { description: "App list", content: { "application/json": { schema: genericJsonObject } } },
  },
});

defineRouteMetadata("post", "/api/v1/apps", {
  tags: ["Apps"],
  summary: "Create developer app",
  security: adminSecurity,
  responses: {
    201: { description: "Created", content: { "application/json": { schema: genericJsonObject } } },
  },
});

registerAppMetadata("get", "", "Get developer app");
registerAppMetadata("put", "", "Update developer app");
registerAppMetadata("delete", "", "Delete developer app");

// Users
registerAppMetadata("get", "/users", "List provisioned users", { tags: ["Users"] });
registerAppMetadata("post", "/users", "Upsert provisioned user", { tags: ["Users"] });
registerAppMetadata("put", "/users", "Update provisioned user", { tags: ["Users"] });
registerAppMetadata("delete", "/users", "Deactivate provisioned user", { tags: ["Users"] });

registerUserMetadata("get", "/keys", "List user API keys");
registerUserMetadata("post", "/keys", "Create user API key");
registerUserMetadata("delete", "/keys", "Revoke user API key");

registerUserMetadata("get", "/allowances", "List user allowances");
registerUserMetadata("post", "/allowances", "Grant user allowance");
registerUserMetadata("get", "/subscription", "Get user subscription");

defineRouteMetadata("post", appPath("/credentials"), {
  tags: ["Credentials"],
  summary: "Rotate M2M client secret",
  description: "Provider session rotates the confidential `m2m_*` client secret.",
  security: adminSecurity,
  request: { params: z.object({ clientId }) },
  responses: {
    200: jsonSuccess,
    ...builderErrorResponses,
  },
});

// Usage
registerAppMetadata("get", "/usage", "Usage summary", { tags: ["Usage"] });
registerAppMetadata("get", "/usage/balance", "Usage balance (M2M)", { tags: ["Usage"] });

// Billing & plans
registerAppMetadata("get", "/billing", "Billing profile", { tags: ["Billing"] });
registerAppMetadata("post", "/billing/checkout", "Create billing checkout", { tags: ["Billing"] });
registerAppMetadata("get", "/billing/invoices", "List invoices", { tags: ["Billing"] });
registerAppMetadata("get", "/billing/stripe", "Stripe billing status", { tags: ["Billing"] });
registerAppMetadata("delete", "/billing/stripe", "Disconnect Stripe billing", { tags: ["Billing"] });
registerAppMetadata("post", "/billing/stripe/connect", "Stripe Connect", { tags: ["Billing"] });
registerAppMetadata("get", "/billing/stripe/callback", "Stripe OAuth callback", { tags: ["Billing"] });
registerAppMetadata("get", "/plans", "List plans", { tags: ["Billing"] });
registerAppMetadata("post", "/plans", "Create plan", { tags: ["Billing"] });
registerAppMetadata("put", "/plans", "Update plan", { tags: ["Billing"] });
registerAppMetadata("delete", "/plans", "Delete plan", { tags: ["Billing"] });
defineRouteMetadata("post", appPath("/plans/{planId}/sync"), {
  tags: ["Billing"],
  summary: "Sync plan to OpenMeter",
  security: m2mSecurity,
  request: {
    params: z.object({
      clientId,
      planId: z.string().openapi({ param: { name: "planId", in: "path" } }),
    }),
  },
  responses: {
    200: jsonSuccess,
    ...builderErrorResponses,
  },
});
registerAppMetadata("put", "/starter-plan", "Update starter plan config", { tags: ["Billing"] });
registerAppMetadata("get", "/starter-plan", "Starter plan config", { tags: ["Billing"] });

// Discovery & publish
registerAppMetadata("get", "/discovery-profiles", "List discovery profiles", { tags: ["Discovery"] });
registerAppMetadata("post", "/discovery-profiles", "Create discovery profile", { tags: ["Discovery"] });

defineRouteMetadata("get", "/api/v1/apps/{clientId}/discovery-profiles/{profileId}", {
  tags: ["Discovery"],
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

defineRouteMetadata("put", "/api/v1/apps/{clientId}/discovery-profiles/{profileId}", {
  tags: ["Discovery"],
  summary: "Update discovery profile",
  security: m2mSecurity,
  request: {
    params: z.object({
      clientId,
      profileId: z.string().openapi({ param: { name: "profileId", in: "path" } }),
    }),
  },
  responses: { 200: jsonSuccess },
});

defineRouteMetadata("delete", "/api/v1/apps/{clientId}/discovery-profiles/{profileId}", {
  tags: ["Discovery"],
  summary: "Delete discovery profile",
  security: m2mSecurity,
  request: {
    params: z.object({
      clientId,
      profileId: z.string().openapi({ param: { name: "profileId", in: "path" } }),
    }),
  },
  responses: { 204: { description: "Deleted" } },
});

registerAppMetadata("get", "/manifest", "App manifest", { tags: ["Discovery"] });
registerAppMetadata("put", "/manifest", "Update app manifest", { tags: ["Discovery"] });
registerAppMetadata("post", "/publish", "Publish app", { tags: ["Discovery"] });
registerAppMetadata("post", "/submit", "Submit app for review", { tags: ["Discovery"] });
registerAppMetadata("post", "/revert-draft", "Revert draft manifest", { tags: ["Discovery"] });

// Settings & admin
registerAppMetadata("put", "/settings", "Update app settings");
registerAppMetadata("get", "/admins", "List app admins");
registerAppMetadata("post", "/admins", "Add app admin");
registerAppMetadata("delete", "/admins", "Remove app admin");
registerAppMetadata("get", "/domains", "Custom domains");
registerAppMetadata("post", "/domains", "Add custom domain");
registerAppMetadata("delete", "/domains", "Remove custom domain");
registerAppMetadata("get", "/openmeter", "OpenMeter config");
registerAppMetadata("put", "/openmeter", "Update OpenMeter config");
registerAppMetadata("get", "/signer/routing", "Signer routing config");

defineRouteMetadata("get", "/api/v1/apps/branding", {
  tags: ["Apps"],
  summary: "Resolve app branding by host",
  responses: {
    200: { description: "Branding", content: { "application/json": { schema: genericJsonObject } } },
  },
});
