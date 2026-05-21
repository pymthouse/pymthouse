import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "oidc-provider"],
  /**
   * Remote signers (go-livepeer) and some gateways POST to `/sign-orchestrator-info`
   * etc. at the **origin root**. PymtHouse exposes the proxy under `/api/signer/*`.
   * Rewrites map the root paths to the real App Router handlers (no extra hop;
   * same as redirect for clients but preserves POST bodies without a 307 round-trip).
   */
  async rewrites() {
    return [
      {
        source: "/sign-orchestrator-info",
        destination: "/api/signer/sign-orchestrator-info",
      },
      {
        source: "/sign-byoc-job",
        destination: "/api/signer/sign-byoc-job",
      },
      {
        source: "/discover-orchestrators",
        destination: "/api/signer/discover-orchestrators",
      },
      {
        source: "/generate-live-payment",
        destination: "/api/signer/generate-live-payment",
      },
    ];
  },
};

export default nextConfig;
