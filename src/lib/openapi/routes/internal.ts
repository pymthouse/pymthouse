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
const sessionSecurity: Array<Record<string, string[]>> = [{ adminSession: [] }];

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

type MetadataRoute = [
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  tag: string,
  summary: string,
  flags?: string,
];

function registerMetadataRoutes(routes: MetadataRoute[]): void {
  for (const [method, path, tag, summary, flags = ""] of routes) {
    meta(method, path, {
      tags: [tag],
      summary,
      params: flags.includes("c"),
      planId: flags.includes("p"),
      profileId: flags.includes("d"),
      virtual: flags.includes("v"),
    });
  }
}

registerMetadataRoutes([
  ["get", "/api/v1/internal/me/usage/requests", OPENAPI_TAGS.viewerUsage, "List signed-ticket request history for the session user"],
  ["get", "/api/v1/internal/dashboard/usage", OPENAPI_TAGS.viewerUsage, "Dashboard usage summary for the session user"],
  ["get", "/api/v1/internal/apps", OPENAPI_TAGS.appsAdmin, "List apps for the signed-in provider", "v"],
  ["post", "/api/v1/internal/apps", OPENAPI_TAGS.appsAdmin, "Create app", "v"],
  ["get", internalApp(""), OPENAPI_TAGS.appsAdmin, "Get app (dashboard view)", "cv"],
  ["put", internalApp(""), OPENAPI_TAGS.appsAdmin, "Update app", "cv"],
  ["delete", internalApp(""), OPENAPI_TAGS.appsAdmin, "Delete app", "cv"],
  ["put", internalApp("/settings"), OPENAPI_TAGS.appsAdmin, "Update app settings", "cv"],
  ["post", internalApp("/credentials"), OPENAPI_TAGS.appsAdmin, "Rotate / issue app credentials", "cv"],
  ["post", internalApp("/publish"), OPENAPI_TAGS.appsAdmin, "Publish app to marketplace", "cv"],
  ["get", internalApp("/admins"), OPENAPI_TAGS.team, "List app admins", "cv"],
  ["post", internalApp("/admins"), OPENAPI_TAGS.team, "Add app admin", "cv"],
  ["delete", internalApp("/admins"), OPENAPI_TAGS.team, "Remove app admin", "cv"],
  ["get", internalApp("/domains"), OPENAPI_TAGS.team, "List custom domains", "cv"],
  ["post", internalApp("/domains"), OPENAPI_TAGS.team, "Add custom domain", "cv"],
  ["delete", internalApp("/domains"), OPENAPI_TAGS.team, "Remove custom domain", "cv"],
  ["get", internalApp("/openmeter"), OPENAPI_TAGS.plans, "Get OpenMeter linkage", "cv"],
  ["put", internalApp("/openmeter"), OPENAPI_TAGS.plans, "Update OpenMeter linkage", "cv"],
  ["get", internalApp("/starter-plan"), OPENAPI_TAGS.plans, "Get starter plan", "cv"],
  ["put", internalApp("/starter-plan"), OPENAPI_TAGS.plans, "Update starter plan", "cv"],
  ["post", internalApp("/plans"), OPENAPI_TAGS.plans, "Create plan", "cv"],
  ["put", internalApp("/plans"), OPENAPI_TAGS.plans, "Update plan", "cv"],
  ["delete", internalApp("/plans"), OPENAPI_TAGS.plans, "Delete plan", "cv"],
  ["post", internalApp("/plans/{planId}/sync"), OPENAPI_TAGS.plans, "Sync plan to OpenMeter", "cpv"],
  ["get", internalApp("/signer/routing"), OPENAPI_TAGS.appsAdmin, "Get signer DMZ routing for the app", "cv"],
  ["post", internalApp("/discovery-profiles"), OPENAPI_TAGS.appDiscovery, "Create discovery profile", "cv"],
  ["put", internalApp("/discovery-profiles/{profileId}"), OPENAPI_TAGS.appDiscovery, "Update discovery profile", "cdv"],
  ["delete", internalApp("/discovery-profiles/{profileId}"), OPENAPI_TAGS.appDiscovery, "Delete discovery profile", "cdv"],
  ["put", internalApp("/manifest"), OPENAPI_TAGS.appDiscovery, "Update app manifest", "cv"],
  ["get", internalApp("/billing/stripe"), OPENAPI_TAGS.merchantBilling, "Get Stripe Connect status", "cv"],
  ["delete", internalApp("/billing/stripe"), OPENAPI_TAGS.merchantBilling, "Disconnect Stripe", "cv"],
  ["post", internalApp("/billing/stripe/connect"), OPENAPI_TAGS.merchantBilling, "Start Stripe Connect", "cv"],
  ["get", internalApp("/billing/stripe/callback"), OPENAPI_TAGS.merchantBilling, "Stripe Connect OAuth callback", "cv"],
  ["get", internalApp("/billing/invoices"), OPENAPI_TAGS.merchantBilling, "List merchant invoices", "cv"],
  ["get", "/api/v1/internal/admin/apps", OPENAPI_TAGS.admin, "List all apps (platform admin)", "v"],
  ["get", "/api/v1/internal/admin/oidc-clients", OPENAPI_TAGS.admin, "List OIDC clients (platform admin)", "v"],
  ["patch", "/api/v1/internal/admin/oidc-clients", OPENAPI_TAGS.admin, "Update OIDC client (platform admin)", "v"],
  ["patch", "/api/v1/internal/admin/apps/{clientId}/marketplace-featured", OPENAPI_TAGS.admin, "Set marketplace featured flag", "cv"],
  ["get", "/api/v1/internal/signer", OPENAPI_TAGS.signer, "Get platform signer config", "v"],
  ["patch", "/api/v1/internal/signer", OPENAPI_TAGS.signer, "Update platform signer config", "v"],
  ["get", "/api/v1/internal/signer/cli-status", OPENAPI_TAGS.signer, "Signer CLI status", "v"],
  ["get", "/api/v1/internal/signer/logs", OPENAPI_TAGS.signer, "Signer logs", "v"],
  ["post", "/api/v1/internal/signer/control", OPENAPI_TAGS.signer, "Signer control action", "v"],
  ["get", "/api/v1/internal/billing", OPENAPI_TAGS.merchantBilling, "Platform billing overview for the session user", "v"],
  ["get", "/api/v1/end-users", OPENAPI_TAGS.users, "List Turnkey end-users for the session"],
  ["post", "/api/v1/end-users", OPENAPI_TAGS.users, "Register Turnkey end-user"],
]);
