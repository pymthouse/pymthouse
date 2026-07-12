/** OpenAPI tag names used across route metadata. */
export const OPENAPI_TAGS = {
  app: "App",
  users: "Users",
  credentials: "Credentials",
  usage: "Usage",
  billing: "Billing",
  discovery: "Discovery",
  endUserUsage: "End-user Usage",
  marketplace: "Marketplace",
  platform: "Platform",
  oidc: "OIDC",
  // Internal
  appsAdmin: "Apps",
  team: "Team",
  merchantBilling: "Merchant billing",
  plans: "Plans",
  appDiscovery: "App discovery",
  viewerUsage: "Viewer usage",
  admin: "Admin",
  signer: "Signer",
} as const;

export type OpenApiTagName = (typeof OPENAPI_TAGS)[keyof typeof OPENAPI_TAGS];

export type OpenApiAudience = "builder" | "end-user" | "internal";

/**
 * Builder (M2M) contract — integrator backends only.
 * Dashboard / PymtHouse-app ops live in the Internal document.
 */
const BUILDER_OPERATION_KEYS = new Set([
  "GET /api/v1/health",
  "GET /api/v1/marketplace",
  "GET /api/v1/marketplace/{id}",
  "GET /api/v1/pipeline-catalog",
  "GET /api/v1/pipeline-pricing",
  "GET /api/v1/prices/eth-usd",
  "POST /api/v1/auth/validate",
  "GET /api/v1/apps/{clientId}",
  "GET /api/v1/apps/{clientId}/users",
  "POST /api/v1/apps/{clientId}/users",
  "PUT /api/v1/apps/{clientId}/users",
  "DELETE /api/v1/apps/{clientId}/users",
  "GET /api/v1/apps/{clientId}/users/{externalUserId}/keys",
  "POST /api/v1/apps/{clientId}/users/{externalUserId}/keys",
  "DELETE /api/v1/apps/{clientId}/users/{externalUserId}/keys",
  "POST /api/v1/apps/{clientId}/users/{externalUserId}/token",
  "GET /api/v1/apps/{clientId}/users/{externalUserId}/allowances",
  "POST /api/v1/apps/{clientId}/users/{externalUserId}/allowances",
  "GET /api/v1/apps/{clientId}/users/{externalUserId}/subscription",
  "POST /api/v1/apps/{clientId}/oidc/token",
  "POST /api/v1/oidc/token",
  "GET /api/v1/builder/apps/{clientId}/usage",
  "GET /api/v1/builder/apps/{clientId}/usage/balance",
  "GET /api/v1/apps/{clientId}/billing",
  "POST /api/v1/apps/{clientId}/billing/checkout",
  "GET /api/v1/apps/{clientId}/plans",
  "GET /api/v1/apps/{clientId}/manifest",
  "GET /api/v1/apps/{clientId}/discovery-profiles",
  "GET /api/v1/apps/{clientId}/discovery-profiles/{profileId}",
]);

const END_USER_OPERATION_KEYS = new Set([
  "GET /api/v1/user/usage",
  "GET /api/v1/user/usage/balance",
  "GET /api/v1/user/usage/requests",
]);

/**
 * Internal contract — PymtHouse dashboard / admin.
 * Prefer `/api/v1/internal/…` (rewrites to legacy `/apps`, `/admin`, `/signer` where noted).
 */
const INTERNAL_OPERATION_KEYS = new Set([
  // Viewer / dashboard usage (real routes)
  "GET /api/v1/internal/me/usage/requests",
  "GET /api/v1/internal/dashboard/usage",
  // Apps admin (rewrite → /api/v1/apps/…)
  "GET /api/v1/internal/apps",
  "POST /api/v1/internal/apps",
  "GET /api/v1/internal/apps/{clientId}",
  "PUT /api/v1/internal/apps/{clientId}",
  "DELETE /api/v1/internal/apps/{clientId}",
  "PUT /api/v1/internal/apps/{clientId}/settings",
  "POST /api/v1/internal/apps/{clientId}/credentials",
  "GET /api/v1/internal/apps/{clientId}/admins",
  "POST /api/v1/internal/apps/{clientId}/admins",
  "DELETE /api/v1/internal/apps/{clientId}/admins",
  "GET /api/v1/internal/apps/{clientId}/domains",
  "POST /api/v1/internal/apps/{clientId}/domains",
  "DELETE /api/v1/internal/apps/{clientId}/domains",
  "POST /api/v1/internal/apps/{clientId}/publish",
  "GET /api/v1/internal/apps/{clientId}/openmeter",
  "PUT /api/v1/internal/apps/{clientId}/openmeter",
  "GET /api/v1/internal/apps/{clientId}/signer/routing",
  "GET /api/v1/internal/apps/{clientId}/starter-plan",
  "PUT /api/v1/internal/apps/{clientId}/starter-plan",
  "POST /api/v1/internal/apps/{clientId}/plans",
  "PUT /api/v1/internal/apps/{clientId}/plans",
  "DELETE /api/v1/internal/apps/{clientId}/plans",
  "POST /api/v1/internal/apps/{clientId}/plans/{planId}/sync",
  "POST /api/v1/internal/apps/{clientId}/discovery-profiles",
  "PUT /api/v1/internal/apps/{clientId}/discovery-profiles/{profileId}",
  "DELETE /api/v1/internal/apps/{clientId}/discovery-profiles/{profileId}",
  "PUT /api/v1/internal/apps/{clientId}/manifest",
  "GET /api/v1/internal/apps/{clientId}/billing/stripe",
  "DELETE /api/v1/internal/apps/{clientId}/billing/stripe",
  "POST /api/v1/internal/apps/{clientId}/billing/stripe/connect",
  "GET /api/v1/internal/apps/{clientId}/billing/stripe/callback",
  "GET /api/v1/internal/apps/{clientId}/billing/invoices",
  // Platform admin / signer (rewrite → /admin, /signer)
  "GET /api/v1/internal/admin/apps",
  "GET /api/v1/internal/admin/oidc-clients",
  "PATCH /api/v1/internal/admin/oidc-clients",
  "PATCH /api/v1/internal/admin/apps/{clientId}/marketplace-featured",
  "GET /api/v1/internal/signer",
  "PATCH /api/v1/internal/signer",
  "GET /api/v1/internal/signer/cli-status",
  "GET /api/v1/internal/signer/logs",
  "POST /api/v1/internal/signer/control",
  "GET /api/v1/internal/billing",
  // Turnkey / end-users (actual path; no /internal rewrite)
  "GET /api/v1/end-users",
  "POST /api/v1/end-users",
]);

export function openApiOperationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Classify a single operation for the split OpenAPI documents.
 * Returns null for protocol-only / docs meta routes not in any contract.
 */
export function classifyOpenApiOperation(
  method: string,
  path: string,
): OpenApiAudience | null {
  const key = openApiOperationKey(method, path);
  if (END_USER_OPERATION_KEYS.has(key)) {
    return "end-user";
  }
  if (BUILDER_OPERATION_KEYS.has(key)) {
    return "builder";
  }
  if (INTERNAL_OPERATION_KEYS.has(key)) {
    return "internal";
  }
  return null;
}

export function isOpenApiContractOperation(method: string, path: string): boolean {
  return classifyOpenApiOperation(method, path) != null;
}

export const BUILDER_TAG_DEFINITIONS: Array<{
  name: OpenApiTagName;
  description: string;
}> = [
  {
    name: OPENAPI_TAGS.app,
    description: "Read app context for the authenticated M2M client.",
  },
  {
    name: OPENAPI_TAGS.users,
    description: "Provision end users, API keys, tokens, allowances, and subscription.",
  },
  {
    name: OPENAPI_TAGS.credentials,
    description: "RFC 8693 signer session exchange and related credential flows.",
  },
  {
    name: OPENAPI_TAGS.usage,
    description:
      "App-wide usage and balance. `GET /api/v1/builder/apps/{clientId}/usage*` (M2M Basic only).",
  },
  {
    name: OPENAPI_TAGS.endUserUsage,
    description:
      "Self-serve usage for the authenticated end user. Bearer = composite `app_*_*` API key, bare `pmth_*` key, or end-user/signer JWT.",
  },
  {
    name: OPENAPI_TAGS.billing,
    description: "Billing profile, plan list, and checkout for integrator backends.",
  },
  {
    name: OPENAPI_TAGS.discovery,
    description: "Read discovery profiles and app manifest.",
  },
  {
    name: OPENAPI_TAGS.marketplace,
    description: "Public marketplace catalog.",
  },
  {
    name: OPENAPI_TAGS.platform,
    description: "Health, prices, and auth validate.",
  },
  {
    name: OPENAPI_TAGS.oidc,
    description: "OIDC provider token endpoint (issuer protocol).",
  },
];

export const BUILDER_TAG_GROUPS: Array<{ name: string; tags: OpenApiTagName[] }> = [
  {
    name: "Integrator",
    tags: [
      OPENAPI_TAGS.app,
      OPENAPI_TAGS.users,
      OPENAPI_TAGS.credentials,
      OPENAPI_TAGS.usage,
      OPENAPI_TAGS.billing,
      OPENAPI_TAGS.discovery,
    ],
  },
  {
    name: "End-user",
    tags: [OPENAPI_TAGS.endUserUsage],
  },
  {
    name: "Catalog",
    tags: [OPENAPI_TAGS.marketplace, OPENAPI_TAGS.platform],
  },
  {
    name: "OIDC",
    tags: [OPENAPI_TAGS.oidc],
  },
];

/** @deprecated End-user ops live in the main (Builder) document. */
export const END_USER_TAG_DEFINITIONS = BUILDER_TAG_DEFINITIONS.filter(
  (tag) => tag.name === OPENAPI_TAGS.endUserUsage,
);
/** @deprecated End-user ops live in the main (Builder) document. */
export const END_USER_TAG_GROUPS: Array<{ name: string; tags: OpenApiTagName[] }> = [
  { name: "End-user", tags: [OPENAPI_TAGS.endUserUsage] },
];

export const INTERNAL_TAG_DEFINITIONS: Array<{
  name: OpenApiTagName;
  description: string;
}> = [
  {
    name: OPENAPI_TAGS.appsAdmin,
    description: "Create/update/delete apps, settings, credentials, publish (session).",
  },
  {
    name: OPENAPI_TAGS.team,
    description: "App admins and custom domains.",
  },
  {
    name: OPENAPI_TAGS.plans,
    description: "Plan editor, starter plan, OpenMeter sync.",
  },
  {
    name: OPENAPI_TAGS.appDiscovery,
    description: "Mutate discovery profiles and manifest.",
  },
  {
    name: OPENAPI_TAGS.merchantBilling,
    description: "Stripe Connect, invoices, merchant billing UI.",
  },
  {
    name: OPENAPI_TAGS.viewerUsage,
    description: "Signed-in viewer request history and dashboard usage summary.",
  },
  {
    name: OPENAPI_TAGS.admin,
    description: "Platform admin apps and OIDC clients.",
  },
  {
    name: OPENAPI_TAGS.signer,
    description: "Platform signer configuration and control.",
  },
  {
    name: OPENAPI_TAGS.users,
    description: "Turnkey / end-user registration helpers.",
  },
];

export const INTERNAL_TAG_GROUPS: Array<{ name: string; tags: OpenApiTagName[] }> = [
  {
    name: "Dashboard",
    tags: [
      OPENAPI_TAGS.appsAdmin,
      OPENAPI_TAGS.team,
      OPENAPI_TAGS.plans,
      OPENAPI_TAGS.appDiscovery,
      OPENAPI_TAGS.merchantBilling,
      OPENAPI_TAGS.viewerUsage,
    ],
  },
  {
    name: "Platform",
    tags: [OPENAPI_TAGS.admin, OPENAPI_TAGS.signer, OPENAPI_TAGS.users],
  },
];

export const BUILDER_INFO_DESCRIPTION = `PymtHouse **public API** — Builder (M2M) and End-user contracts.

**Builder (M2M):** HTTP Basic (\`m2m_*\` + \`pmth_cs_*\`) for integrator backends — users, keys, tokens, app usage, billing reads, discovery.

**End-user:** \`Authorization: Bearer\` with a composite \`app_*_*\` API key, bare \`pmth_*\` key, programmatic user JWT, or signer JWT. Identity comes **only** from the token — do not pass \`externalUserId\`.

OIDC discovery: \`{issuer}/.well-known/openid-configuration\`.

Canonical Builder usage: \`GET /api/v1/builder/apps/{clientId}/usage*\`.
Canonical End-user usage: \`GET /api/v1/user/usage*\`.
`;

/** @deprecated End-user lives in the main public document (`BUILDER_INFO_DESCRIPTION`). */
export const END_USER_INFO_DESCRIPTION = BUILDER_INFO_DESCRIPTION;

export const INTERNAL_INFO_DESCRIPTION = `PymtHouse **Internal API** — dashboard, admin, and platform ops for the PymtHouse application (not linked from public docs).

Authenticate with a NextAuth session cookie and/or admin-scoped Bearer token.

Canonical paths use the \`/api/v1/internal/…\` prefix. Many app-admin routes rewrite to legacy \`/api/v1/apps/…\` handlers (same auth). Prefer the \`/internal\` paths in new code.

Public integrator docs: \`/api/v1/docs\`.
`;

/** @deprecated Use BUILDER_TAG_DEFINITIONS. */
export const OPENAPI_TAG_DEFINITIONS = BUILDER_TAG_DEFINITIONS;
/** @deprecated Use BUILDER_TAG_GROUPS. */
export const OPENAPI_TAG_GROUPS = BUILDER_TAG_GROUPS;
/** @deprecated Use BUILDER_INFO_DESCRIPTION. */
export const OPENAPI_INFO_DESCRIPTION = BUILDER_INFO_DESCRIPTION;
