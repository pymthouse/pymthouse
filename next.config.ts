import type { NextConfig } from "next";
import path from "node:path";

const turnkeyAuthComponent = path.join(
  process.cwd(),
  "node_modules/@turnkey/react-wallet-kit/dist/components/auth/index.mjs",
);

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "better-sqlite3",
    "oidc-provider",
    "@pymthouse/builder-sdk",
    "@pymthouse/builder-sdk/signer/server",
    "@pymthouse/clearinghouse-identity-webhook",
  ],
  webpack: (config, { isServer }) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...config.resolve.alias,
      // AuthComponent is unpublished; pin the ESM build so it shares
      // ClientContext with TurnkeyProvider (CJS deep import breaks the context).
      "@turnkey/react-wallet-kit/auth-component": turnkeyAuthComponent,
    };
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
