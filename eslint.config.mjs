import next from "eslint-config-next";

const config = [
  ...next,
  {
    ignores: [
      ".next/**",
      "control-plane/.next/**",
      "coverage/**",
      "test-results/**",
      "dist/**",
      "build/**",
    ],
  },
  {
    files: [
      "src/app/api/v1/apps/[id]/plans/route.ts",
      "src/app/api/v1/apps/[id]/plans/discovery/route.ts",
      "src/app/api/v1/apps/[id]/discovery-profiles/route.ts",
      "src/app/api/v1/apps/[id]/discovery-profiles/[profileId]/route.ts",
      "src/app/api/v1/subscriptions/route.ts",
      "src/app/api/v1/end-users/route.ts",
      "src/app/api/v1/tokens/route.ts",
      "src/app/api/v1/auth/validate/route.ts",
      "src/app/api/v1/admin/invites/route.ts",
      "src/app/api/v1/health/route.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/db/index",
              message:
                "Plans/discovery route adapters must call domain repo/runtime modules instead of importing the DB directly.",
            },
            {
              name: "@/db/schema",
              message:
                "Plans/discovery route adapters must call domain repo/runtime modules instead of importing schema tables directly.",
            },
            {
              name: "@/lib/discovery-profile-resolve",
              message:
                "Import discovery read shaping through src/domains/plans-discovery/runtime instead of lib helpers.",
            },
            {
              name: "@/lib/discovery-plans",
              message:
                "Import discovery input rules through src/domains/plans-discovery/service instead of route-local wiring.",
            },
            {
              name: "@/lib/provider-apps",
              message:
                "Plans/discovery route adapters must import developer-app authorization from src/domains/developer-apps instead of the legacy compatibility wrapper.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/app/dashboard/page.tsx",
      "src/app/streams/page.tsx",
      "src/app/users/page.tsx",
      "src/app/users/[id]/page.tsx",
      "src/app/signer/page.tsx",
      "src/app/api/v1/oidc/interaction/[uid]/route.ts",
      "src/app/api/v1/oidc/device/verify/route.ts",
      "src/app/api/v1/admin/oidc-clients/route.ts",
      "src/app/api/v1/apps/branding/route.ts",
      "src/app/api/v1/signer/route.ts",
      "src/app/api/v1/signer/control/route.ts",
      "src/app/api/v1/signer/logs/route.ts",
      "src/app/api/v1/signer/cli-status/route.ts",
      "src/app/api/signer/sign-orchestrator-info/route.ts",
      "src/app/api/signer/sign-byoc-job/route.ts",
      "src/app/api/signer/discover-orchestrators/route.ts",
      "src/app/api/signer/generate-live-payment/route.ts",
      "src/app/api/v1/admin/apps/route.ts",
      "src/app/api/v1/admin/apps/[id]/review/route.ts",
      "src/app/api/v1/admin/apps/[id]/revoke/route.ts",
      "src/app/api/v1/apps/route.ts",
      "src/app/api/v1/apps/[id]/route.ts",
      "src/app/api/v1/apps/[id]/settings/route.ts",
      "src/app/api/v1/apps/[id]/domains/route.ts",
      "src/app/api/v1/apps/[id]/admins/route.ts",
      "src/app/api/v1/apps/[id]/credentials/route.ts",
      "src/app/api/v1/apps/[id]/users/route.ts",
      "src/app/api/v1/apps/[id]/keys/route.ts",
      "src/app/api/v1/apps/[id]/billing/route.ts",
      "src/app/api/v1/apps/[id]/usage/route.ts",
      "src/app/api/v1/apps/[id]/submit/route.ts",
      "src/app/api/v1/apps/[id]/publish/route.ts",
      "src/app/api/v1/apps/[id]/revert-draft/route.ts",
      "src/app/api/v1/apps/[id]/users/[externalUserId]/token/route.ts",
      "src/app/api/v1/billing/route.ts",
      "src/app/api/v1/marketplace/route.ts",
      "src/app/api/v1/marketplace/[id]/route.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/provider-apps",
              message:
                "Import developer-app authorization from src/domains/developer-apps/runtime instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/db/index",
              message:
                "Developer-app route adapters should call domain repo/runtime modules instead of importing the DB directly.",
            },
            {
              name: "@/db/schema",
              message:
                "Developer-app route adapters should call domain repo/runtime modules instead of importing schema tables directly.",
            },
            {
              name: "@/lib/signer-proxy",
              message:
                "Signer route adapters should import signer-runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/clients",
              message:
                "OIDC routes should import client runtime helpers from src/domains/oidc-platform/runtime instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/programmatic-tokens",
              message:
                "OIDC routes should import token runtime helpers from src/domains/oidc-platform/runtime instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/branding",
              message:
                "OIDC routes should import branding helpers from src/domains/oidc-platform/runtime instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/db/index",
              message:
                "Page and route adapters should call domain runtime/repo modules instead of importing the DB directly.",
            },
            {
              name: "@/db/schema",
              message:
                "Page and route adapters should call domain runtime/repo modules instead of importing schema tables directly.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/app/oidc/interaction/page.tsx",
      "src/app/oidc/consent/page.tsx",
      "src/app/oidc/device/page.tsx",
      "src/app/oidc/device/initiate-login/route.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/oidc/provider",
              message:
                "OIDC pages should import provider access through src/domains/oidc-platform/runtime/provider-instance instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/adapter",
              message:
                "OIDC pages should import the provider adapter through src/domains/oidc-platform/runtime/adapter instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/clients",
              message:
                "OIDC pages should import client helpers through src/domains/oidc-platform/runtime instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/branding",
              message:
                "OIDC pages should import branding helpers through src/domains/oidc-platform/runtime instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/app-access",
              message:
                "OIDC pages should import access helpers through src/domains/oidc-platform/runtime instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/host-resolution",
              message:
                "OIDC pages should import host-context helpers through src/domains/oidc-platform/runtime instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/device-approval",
              message:
                "OIDC pages should import device approval through src/domains/oidc-platform/runtime instead of the legacy compatibility wrapper.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/plans-discovery/service/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/*", "@/app/*", "@/components/*"],
              message:
                "plans-discovery service modules must stay framework- and DB-independent.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/plans-discovery/runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/db/schema",
              message:
                "plans-discovery runtime modules should shape data via repo functions instead of importing schema tables directly.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/developer-apps/service/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/*", "@/app/*", "@/components/*"],
              message:
                "developer-apps service modules must stay framework- and DB-independent.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/oidc-platform/service/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/*", "@/app/*", "@/components/*"],
              message:
                "oidc-platform service modules must stay framework- and DB-independent.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/oidc-platform/runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/oidc/clients",
              message:
                "oidc-platform runtime modules should import client helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/account",
              message:
                "oidc-platform runtime modules should import account helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/adapter",
              message:
                "oidc-platform runtime modules should import provider adapter helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/jwks",
              message:
                "oidc-platform runtime modules should import signing-key helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/programmatic-tokens",
              message:
                "oidc-platform runtime modules should import token helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/device-token-exchange",
              message:
                "oidc-platform runtime modules should import token-exchange helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/gateway-token-exchange",
              message:
                "oidc-platform runtime modules should import token-exchange helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/provider",
              message:
                "oidc-platform runtime modules should import provider access from provider-instance instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/branding",
              message:
                "oidc-platform runtime modules should import branding helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/app-access",
              message:
                "oidc-platform runtime modules should import access helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/host-resolution",
              message:
                "oidc-platform runtime modules should import host-context helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
            {
              name: "@/lib/oidc/device-approval",
              message:
                "oidc-platform runtime modules should import device-approval helpers from sibling runtime modules instead of the legacy compatibility wrapper.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/signer-runtime/service/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/*", "@/app/*", "@/components/*"],
              message:
                "signer-runtime service modules must stay framework- and DB-independent.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domains/usage-billing/service/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/*", "@/app/*", "@/components/*"],
              message:
                "usage-billing service modules must stay framework- and DB-independent.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
