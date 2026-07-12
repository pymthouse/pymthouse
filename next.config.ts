import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Phase-1 API surface aliases (filesystem routes take precedence where they exist,
   * e.g. Builder M2M-only usage under /api/v1/builder/apps/.../usage).
   */
  async rewrites() {
    return [
      {
        source: "/api/v1/builder/apps/:path*",
        destination: "/api/v1/apps/:path*",
      },
      {
        source: "/api/v1/internal/admin/:path*",
        destination: "/api/v1/admin/:path*",
      },
      {
        source: "/api/v1/internal/signer/:path*",
        destination: "/api/v1/signer/:path*",
      },
      {
        source: "/api/v1/internal/apps",
        destination: "/api/v1/apps",
      },
      {
        source: "/api/v1/internal/apps/:path*",
        destination: "/api/v1/apps/:path*",
      },
      {
        source: "/api/v1/internal/billing",
        destination: "/api/v1/billing",
      },
      {
        source: "/api/v1/internal/billing/:path*",
        destination: "/api/v1/billing/:path*",
      },
    ];
  },
  serverExternalPackages: [
    "better-sqlite3",
    "oidc-provider",
    "@pymthouse/builder-sdk",
    "@pymthouse/builder-sdk/signer/server",
    "@pymthouse/clearinghouse-identity-webhook",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      const prev = config.externals;
      let externalsList: unknown[] = [];
      if (Array.isArray(prev)) {
        externalsList = prev;
      } else if (prev) {
        externalsList = [prev];
      }
      config.externals = [
        ...externalsList,
        (
          data: { request?: string },
          callback: (err?: Error | null, result?: string) => void,
        ) => {
          const { request } = data;
          if (request?.startsWith("node:")) {
            callback(null, `commonjs ${request.slice("node:".length)}`);
            return;
          }
          callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
