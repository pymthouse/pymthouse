import { defineRoute } from "@/lib/openapi/registry";
import {
  OAuthErrorSchema,
  PublicClientIdPathParamSchema,
  ExternalUserIdParamSchema,
} from "@/lib/openapi/schemas/common";
import { z } from "@/lib/openapi/zod";

const clientId = PublicClientIdPathParamSchema;
const externalUserId = ExternalUserIdParamSchema;

function appPath(suffix: string) {
  return `/api/v1/apps/{clientId}${suffix}`;
}

function userPath(suffix: string) {
  return `/api/v1/apps/{clientId}/users/{externalUserId}${suffix}`;
}

const jsonObject = z.object({}).passthrough().openapi("GenericJsonObject");

function registerAppCrud(
  method: "get" | "post" | "put" | "delete" | "patch",
  suffix: string,
  summary: string,
  options?: { deprecated?: boolean; description?: string; tags?: string[] },
) {
  defineRoute({
    method,
    path: appPath(suffix),
    tags: options?.tags ?? ["Apps"],
    summary,
    description: options?.description,
    deprecated: options?.deprecated,
    security: [{ m2mBasic: [] }, { bearerUserJwt: [] }],
    request: { params: z.object({ clientId }) },
    responses: {
      200: { description: "Success", content: { "application/json": { schema: jsonObject } } },
      400: { description: "Bad request", content: { "application/json": { schema: OAuthErrorSchema } } },
      401: { description: "Unauthorized", content: { "application/json": { schema: OAuthErrorSchema } } },
      403: { description: "Forbidden", content: { "application/json": { schema: OAuthErrorSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: OAuthErrorSchema } } },
    },
  });
}

function registerUserCrud(
  method: "get" | "post" | "put" | "delete" | "patch",
  suffix: string,
  summary: string,
  options?: { deprecated?: boolean; description?: string; tags?: string[] },
) {
  defineRoute({
    method,
    path: userPath(suffix),
    tags: options?.tags ?? ["Users"],
    summary,
    description: options?.description,
    deprecated: options?.deprecated,
    security: [{ m2mBasic: [] }, { bearerUserJwt: [] }],
    request: {
      params: z.object({ clientId, externalUserId }),
    },
    responses: {
      200: { description: "Success", content: { "application/json": { schema: jsonObject } } },
      400: { description: "Bad request", content: { "application/json": { schema: OAuthErrorSchema } } },
      401: { description: "Unauthorized", content: { "application/json": { schema: OAuthErrorSchema } } },
      403: { description: "Forbidden", content: { "application/json": { schema: OAuthErrorSchema } } },
      404: { description: "Not found", content: { "application/json": { schema: OAuthErrorSchema } } },
    },
  });
}

// Apps catalog
defineRoute({
  method: "get",
  path: "/api/v1/apps",
  tags: ["Apps"],
  summary: "List developer apps",
  security: [{ adminSession: [] }],
  responses: {
    200: { description: "App list", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/apps",
  tags: ["Apps"],
  summary: "Create developer app",
  security: [{ adminSession: [] }],
  responses: {
    201: { description: "Created", content: { "application/json": { schema: jsonObject } } },
  },
});

registerAppCrud("get", "", "Get developer app");
registerAppCrud("put", "", "Update developer app");
registerAppCrud("delete", "", "Delete developer app");

// Users
registerAppCrud("get", "/users", "List provisioned users", { tags: ["Users"] });
registerAppCrud("post", "/users", "Upsert provisioned user", { tags: ["Users"] });
registerAppCrud("put", "/users", "Update provisioned user", { tags: ["Users"] });
registerAppCrud("delete", "/users", "Deactivate provisioned user", { tags: ["Users"] });

registerUserCrud("get", "/keys", "List user API keys");
registerUserCrud("post", "/keys", "Create user API key");
registerUserCrud("delete", "/keys", "Revoke user API key");

registerUserCrud("get", "/allowances", "List user allowances");
registerUserCrud("post", "/allowances", "Grant user allowance");
registerUserCrud("get", "/subscription", "Get user subscription");
registerUserCrud("post", "/credits", "Grant user credits");
registerUserCrud("get", "/wallet", "Get user wallet");

// Credentials overlap — document canonical vs deprecated
registerAppCrud("get", "/keys", "List app-level API keys (deprecated)", {
  tags: ["Credentials"],
  deprecated: true,
  description:
    "Deprecated: prefer per-user keys at `/users/{externalUserId}/keys`. Sunset after SDK migration.",
});
registerAppCrud("post", "/keys", "Create app-level API key (deprecated)", {
  tags: ["Credentials"],
  deprecated: true,
});
registerAppCrud("delete", "/keys", "Revoke app-level API key (deprecated)", {
  tags: ["Credentials"],
  deprecated: true,
});

registerAppCrud("get", "/credentials", "List app credentials (deprecated)", {
  tags: ["Credentials"],
  deprecated: true,
  description: "Deprecated overlap with `/keys` and M2M client rotation. Use OpenAPI Credentials tag.",
});
registerAppCrud("post", "/credentials", "Rotate app credentials (deprecated)", {
  tags: ["Credentials"],
  deprecated: true,
});

// Usage
registerAppCrud("get", "/usage", "Usage summary", { tags: ["Usage"] });
registerAppCrud("get", "/usage/balance", "Usage balance (M2M)", { tags: ["Usage"] });
registerAppCrud("get", "/usage/me", "Usage summary (end-user)", { tags: ["Usage"] });
registerAppCrud("get", "/usage/me/balance", "Usage balance (end-user session)", {
  tags: ["Usage"],
  deprecated: true,
  description:
    "Deprecated overlap with `/usage/balance` for M2M callers. Prefer `/usage/balance?externalUserId=…`.",
});
registerAppCrud("post", "/usage/signed-tickets", "Record signed ticket usage", { tags: ["Usage"] });

// Billing & plans
registerAppCrud("get", "/billing", "Billing profile", { tags: ["Billing"] });
registerAppCrud("post", "/billing/checkout", "Create billing checkout", { tags: ["Billing"] });
registerAppCrud("get", "/billing/invoices", "List invoices", { tags: ["Billing"] });
registerAppCrud("get", "/billing/stripe", "Stripe billing status", { tags: ["Billing"] });
registerAppCrud("delete", "/billing/stripe", "Disconnect Stripe billing", { tags: ["Billing"] });
registerAppCrud("post", "/billing/stripe/connect", "Stripe Connect", { tags: ["Billing"] });
registerAppCrud("get", "/billing/stripe/callback", "Stripe OAuth callback", { tags: ["Billing"] });
registerAppCrud("get", "/plans", "List plans", { tags: ["Billing"] });
registerAppCrud("post", "/plans", "Create plan", { tags: ["Billing"] });
registerAppCrud("put", "/plans", "Update plan", { tags: ["Billing"] });
registerAppCrud("delete", "/plans", "Delete plan", { tags: ["Billing"] });
registerAppCrud("post", "/plans/{planId}/sync", "Sync plan to OpenMeter", { tags: ["Billing"] });
registerAppCrud("put", "/starter-plan", "Update starter plan config", { tags: ["Billing"] });
registerAppCrud("get", "/starter-plan", "Starter plan config", { tags: ["Billing"] });

// Discovery & publish
registerAppCrud("get", "/discovery-profiles", "List discovery profiles", { tags: ["Discovery"] });
registerAppCrud("post", "/discovery-profiles", "Create discovery profile", { tags: ["Discovery"] });
defineRoute({
  method: "get",
  path: "/api/v1/apps/{clientId}/discovery-profiles/{profileId}",
  tags: ["Discovery"],
  summary: "Get discovery profile",
  security: [{ m2mBasic: [] }],
  request: {
    params: z.object({
      clientId,
      profileId: z.string().openapi({ param: { name: "profileId", in: "path" } }),
    }),
  },
  responses: {
    200: { description: "Profile", content: { "application/json": { schema: jsonObject } } },
    404: { description: "Not found" },
  },
});
defineRoute({
  method: "put",
  path: "/api/v1/apps/{clientId}/discovery-profiles/{profileId}",
  tags: ["Discovery"],
  summary: "Update discovery profile",
  security: [{ m2mBasic: [] }],
  request: {
    params: z.object({
      clientId,
      profileId: z.string().openapi({ param: { name: "profileId", in: "path" } }),
    }),
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: jsonObject } } },
  },
});
defineRoute({
  method: "delete",
  path: "/api/v1/apps/{clientId}/discovery-profiles/{profileId}",
  tags: ["Discovery"],
  summary: "Delete discovery profile",
  security: [{ m2mBasic: [] }],
  request: {
    params: z.object({
      clientId,
      profileId: z.string().openapi({ param: { name: "profileId", in: "path" } }),
    }),
  },
  responses: { 204: { description: "Deleted" } },
});

registerAppCrud("get", "/manifest", "App manifest", { tags: ["Discovery"] });
registerAppCrud("put", "/manifest", "Update app manifest", { tags: ["Discovery"] });
registerAppCrud("post", "/publish", "Publish app", { tags: ["Discovery"] });
registerAppCrud("post", "/submit", "Submit app for review", { tags: ["Discovery"] });
registerAppCrud("post", "/revert-draft", "Revert draft manifest", { tags: ["Discovery"] });

// Settings & admin
registerAppCrud("get", "/settings", "App settings");
registerAppCrud("put", "/settings", "Update app settings");
registerAppCrud("get", "/admins", "List app admins");
registerAppCrud("post", "/admins", "Add app admin");
registerAppCrud("delete", "/admins", "Remove app admin");
registerAppCrud("get", "/domains", "Custom domains");
registerAppCrud("post", "/domains", "Add custom domain");
registerAppCrud("delete", "/domains", "Remove custom domain");
registerAppCrud("get", "/openmeter", "OpenMeter config");
registerAppCrud("put", "/openmeter", "Update OpenMeter config");
registerAppCrud("get", "/signer/routing", "Signer routing config");

defineRoute({
  method: "get",
  path: "/api/v1/apps/branding",
  tags: ["Apps"],
  summary: "Resolve app branding by host",
  responses: {
    200: { description: "Branding", content: { "application/json": { schema: jsonObject } } },
  },
});
