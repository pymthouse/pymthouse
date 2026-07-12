/**
 * Internal (dashboard / admin) OpenAPI metadata.
 *
 * Canonical paths use `/api/v1/internal/…`. App/admin/signer/billing paths are
 * virtual and rewrite to legacy `/api/v1/apps|admin|signer|billing/…` handlers.
 */
import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import { PublicClientIdPathParamSchema } from "@/lib/openapi/schemas/common";
import {
  builderErrorResponses,
  jsonSuccess,
} from "@/lib/openapi/routes/shared";
import { OPENAPI_TAGS } from "@/lib/openapi/tags";
import { z } from "@/lib/openapi/zod";

const clientId = PublicClientIdPathParamSchema;
const sessionSecurity: Array<Record<string, string[]>> = [
  { adminSession: [] },
  { adminBearer: [] },
];

const rewriteNote =
  "Canonical Internal path. Rewrites to the legacy `/api/v1/apps/…` (or `/admin`/`/signer`/`/billing`) handler with the same auth.";

function internalApp(suffix: string) {
  return `/api/v1/internal/apps/{clientId}${suffix}`;
}

function meta(
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  input: {
    tags: string[];
    summary: string;
    description?: string;
    params?: boolean;
    planId?: boolean;
    profileId?: boolean;
    virtual?: boolean;
  },
) {
  const params: Record<string, z.ZodTypeAny> = {};
  if (input.params) {
    params.clientId = clientId;
  }
  if (input.planId) {
    params.planId = z.string().min(1);
  }
  if (input.profileId) {
    params.profileId = z.string().min(1);
  }
  defineRouteMetadata(method, path, {
    tags: input.tags,
    summary: input.summary,
    description: input.description ?? (input.virtual ? rewriteNote : undefined),
    security: sessionSecurity,
    request: Object.keys(params).length > 0 ? { params: z.object(params) } : undefined,
    responses: { 200: jsonSuccess, ...builderErrorResponses },
    virtual: input.virtual,
  });
}

// --- Real Internal routes ---
meta("get", "/api/v1/internal/me/usage/requests", {
  tags: [OPENAPI_TAGS.viewerUsage],
  summary: "List signed-ticket request history for the session user",
});
meta("get", "/api/v1/internal/dashboard/usage", {
  tags: [OPENAPI_TAGS.viewerUsage],
  summary: "Dashboard usage summary for the session user",
});

// --- Apps list / CRUD (rewrite → /api/v1/apps) ---
meta("get", "/api/v1/internal/apps", {
  tags: [OPENAPI_TAGS.appsAdmin],
  summary: "List apps for the signed-in provider",
  virtual: true,
});
meta("post", "/api/v1/internal/apps", {
  tags: [OPENAPI_TAGS.appsAdmin],
  summary: "Create app",
  virtual: true,
});
meta("get", internalApp(""), {
  tags: [OPENAPI_TAGS.appsAdmin],
  summary: "Get app (dashboard view)",
  params: true,
  virtual: true,
});
meta("put", internalApp(""), {
  tags: [OPENAPI_TAGS.appsAdmin],
  summary: "Update app",
  params: true,
  virtual: true,
});
meta("delete", internalApp(""), {
  tags: [OPENAPI_TAGS.appsAdmin],
  summary: "Delete app",
  params: true,
  virtual: true,
});
meta("put", internalApp("/settings"), {
  tags: [OPENAPI_TAGS.appsAdmin],
  summary: "Update app settings",
  params: true,
  virtual: true,
});
meta("post", internalApp("/credentials"), {
  tags: [OPENAPI_TAGS.appsAdmin],
  summary: "Rotate / issue app credentials",
  params: true,
  virtual: true,
});
meta("post", internalApp("/publish"), {
  tags: [OPENAPI_TAGS.appsAdmin],
  summary: "Publish app to marketplace",
  params: true,
  virtual: true,
});

// --- Team ---
meta("get", internalApp("/admins"), {
  tags: [OPENAPI_TAGS.team],
  summary: "List app admins",
  params: true,
  virtual: true,
});
meta("post", internalApp("/admins"), {
  tags: [OPENAPI_TAGS.team],
  summary: "Add app admin",
  params: true,
  virtual: true,
});
meta("delete", internalApp("/admins"), {
  tags: [OPENAPI_TAGS.team],
  summary: "Remove app admin",
  params: true,
  virtual: true,
});
meta("get", internalApp("/domains"), {
  tags: [OPENAPI_TAGS.team],
  summary: "List custom domains",
  params: true,
  virtual: true,
});
meta("post", internalApp("/domains"), {
  tags: [OPENAPI_TAGS.team],
  summary: "Add custom domain",
  params: true,
  virtual: true,
});
meta("delete", internalApp("/domains"), {
  tags: [OPENAPI_TAGS.team],
  summary: "Remove custom domain",
  params: true,
  virtual: true,
});

// --- Plans / OpenMeter ---
meta("get", internalApp("/openmeter"), {
  tags: [OPENAPI_TAGS.plans],
  summary: "Get OpenMeter linkage",
  params: true,
  virtual: true,
});
meta("put", internalApp("/openmeter"), {
  tags: [OPENAPI_TAGS.plans],
  summary: "Update OpenMeter linkage",
  params: true,
  virtual: true,
});
meta("get", internalApp("/starter-plan"), {
  tags: [OPENAPI_TAGS.plans],
  summary: "Get starter plan",
  params: true,
  virtual: true,
});
meta("put", internalApp("/starter-plan"), {
  tags: [OPENAPI_TAGS.plans],
  summary: "Update starter plan",
  params: true,
  virtual: true,
});
meta("post", internalApp("/plans"), {
  tags: [OPENAPI_TAGS.plans],
  summary: "Create plan",
  params: true,
  virtual: true,
});
meta("put", internalApp("/plans"), {
  tags: [OPENAPI_TAGS.plans],
  summary: "Update plan",
  params: true,
  virtual: true,
});
meta("delete", internalApp("/plans"), {
  tags: [OPENAPI_TAGS.plans],
  summary: "Delete plan",
  params: true,
  virtual: true,
});
meta("post", internalApp("/plans/{planId}/sync"), {
  tags: [OPENAPI_TAGS.plans],
  summary: "Sync plan to OpenMeter",
  params: true,
  planId: true,
  virtual: true,
});
meta("get", internalApp("/signer/routing"), {
  tags: [OPENAPI_TAGS.appsAdmin],
  summary: "Get signer DMZ routing for the app",
  params: true,
  virtual: true,
});

// --- Discovery mutations ---
meta("post", internalApp("/discovery-profiles"), {
  tags: [OPENAPI_TAGS.appDiscovery],
  summary: "Create discovery profile",
  params: true,
  virtual: true,
});
meta("put", internalApp("/discovery-profiles/{profileId}"), {
  tags: [OPENAPI_TAGS.appDiscovery],
  summary: "Update discovery profile",
  params: true,
  profileId: true,
  virtual: true,
});
meta("delete", internalApp("/discovery-profiles/{profileId}"), {
  tags: [OPENAPI_TAGS.appDiscovery],
  summary: "Delete discovery profile",
  params: true,
  profileId: true,
  virtual: true,
});
meta("put", internalApp("/manifest"), {
  tags: [OPENAPI_TAGS.appDiscovery],
  summary: "Update app manifest",
  params: true,
  virtual: true,
});

// --- Merchant billing / Stripe ---
meta("get", internalApp("/billing/stripe"), {
  tags: [OPENAPI_TAGS.merchantBilling],
  summary: "Get Stripe Connect status",
  params: true,
  virtual: true,
});
meta("delete", internalApp("/billing/stripe"), {
  tags: [OPENAPI_TAGS.merchantBilling],
  summary: "Disconnect Stripe",
  params: true,
  virtual: true,
});
meta("post", internalApp("/billing/stripe/connect"), {
  tags: [OPENAPI_TAGS.merchantBilling],
  summary: "Start Stripe Connect",
  params: true,
  virtual: true,
});
meta("get", internalApp("/billing/stripe/callback"), {
  tags: [OPENAPI_TAGS.merchantBilling],
  summary: "Stripe Connect OAuth callback",
  params: true,
  virtual: true,
});
meta("get", internalApp("/billing/invoices"), {
  tags: [OPENAPI_TAGS.merchantBilling],
  summary: "List merchant invoices",
  params: true,
  virtual: true,
});

// --- Platform admin (rewrite → /api/v1/admin) ---
meta("get", "/api/v1/internal/admin/apps", {
  tags: [OPENAPI_TAGS.admin],
  summary: "List all apps (platform admin)",
  virtual: true,
});
meta("get", "/api/v1/internal/admin/oidc-clients", {
  tags: [OPENAPI_TAGS.admin],
  summary: "List OIDC clients (platform admin)",
  virtual: true,
});
meta("patch", "/api/v1/internal/admin/oidc-clients", {
  tags: [OPENAPI_TAGS.admin],
  summary: "Update OIDC client (platform admin)",
  virtual: true,
});
meta("patch", "/api/v1/internal/admin/apps/{clientId}/marketplace-featured", {
  tags: [OPENAPI_TAGS.admin],
  summary: "Set marketplace featured flag",
  params: true,
  virtual: true,
});

// --- Signer (rewrite → /api/v1/signer) ---
meta("get", "/api/v1/internal/signer", {
  tags: [OPENAPI_TAGS.signer],
  summary: "Get platform signer config",
  virtual: true,
});
meta("patch", "/api/v1/internal/signer", {
  tags: [OPENAPI_TAGS.signer],
  summary: "Update platform signer config",
  virtual: true,
});
meta("get", "/api/v1/internal/signer/cli-status", {
  tags: [OPENAPI_TAGS.signer],
  summary: "Signer CLI status",
  virtual: true,
});
meta("get", "/api/v1/internal/signer/logs", {
  tags: [OPENAPI_TAGS.signer],
  summary: "Signer logs",
  virtual: true,
});
meta("post", "/api/v1/internal/signer/control", {
  tags: [OPENAPI_TAGS.signer],
  summary: "Signer control action",
  virtual: true,
});

meta("get", "/api/v1/internal/billing", {
  tags: [OPENAPI_TAGS.merchantBilling],
  summary: "Platform billing overview for the session user",
  virtual: true,
});

// --- Turnkey / end-users (actual path; no /internal rewrite) ---
meta("get", "/api/v1/end-users", {
  tags: [OPENAPI_TAGS.users],
  summary: "List Turnkey end-users for the session",
});
meta("post", "/api/v1/end-users", {
  tags: [OPENAPI_TAGS.users],
  summary: "Register Turnkey end-user",
});
