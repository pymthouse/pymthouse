import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
