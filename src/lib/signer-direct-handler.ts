import { readPymthouseEnv } from "@pymthouse/builder-sdk/config";
import {
  createDirectSignerProxyHandler,
  normalizeSignerBaseUrl,
  type DirectSignerProxyHandler,
} from "@pymthouse/builder-sdk/signer/server";
import { getIssuer } from "@/lib/oidc/issuer-urls";
import {
  authenticateSignerSession,
  resolveSignerExternalUserId,
  resolveSignerPublicClientId,
  type SignerSession,
} from "@/lib/signer-session";

let cachedHandler: DirectSignerProxyHandler | null = null;

export function resetGenerateLivePaymentHandlerForTests(): void {
  cachedHandler = null;
}

function resolveRemoteSignerUrl(): string {
  const testSignerUrl =
    process.env.NODE_ENV === "test" ? process.env.PYMTHOUSE_TEST_SIGNER_URL : undefined;
  if (testSignerUrl?.trim()) {
    return normalizeSignerBaseUrl(testSignerUrl);
  }
  const direct = process.env.LIVEPEER_REMOTE_SIGNER_URL?.trim();
  if (direct) {
    return normalizeSignerBaseUrl(direct);
  }
  const internal = process.env.SIGNER_INTERNAL_URL?.trim();
  if (internal) {
    return normalizeSignerBaseUrl(internal);
  }
  throw new Error("LIVEPEER_REMOTE_SIGNER_URL or SIGNER_INTERNAL_URL is required");
}

export function getGenerateLivePaymentHandler(): DirectSignerProxyHandler {
  if (cachedHandler) {
    return cachedHandler;
  }

  const env = readPymthouseEnv();
  if (!env) {
    throw new Error(
      "PYMTHOUSE_M2M_CLIENT_ID and PYMTHOUSE_M2M_CLIENT_SECRET are required for signer proxy",
    );
  }

  cachedHandler = createDirectSignerProxyHandler({
    pymthouseIssuerUrl: getIssuer(),
    pymthouseClientId: env.publicClientId,
    pymthouseM2MClientId: env.m2mClientId,
    pymthouseM2MClientSecret: env.m2mClientSecret,
    remoteSignerUrl: resolveRemoteSignerUrl(),
    proxyPathPrefix: "/api/signer",
    defaultRemotePath: "/generate-live-payment",
    metering: { mode: "pymthouse_hosted" },
    authenticate: authenticateSignerSession,
    resolvePublicClientId: (session) =>
      resolveSignerPublicClientId(session as SignerSession),
    resolveExternalUserId: (session) =>
      resolveSignerExternalUserId(session as SignerSession),
    beforeSign: async ({ token }) => {
      if (BigInt(token.balanceUsdMicros || "0") <= 0n) {
        return {
          status: 402,
          body: {
            error: "trial_credits_exhausted",
            error_description: "Starter allowance exhausted",
          },
        };
      }
    },
    allowInsecureHttp:
      process.env.SIGNER_WEBHOOK_ALLOW_INSECURE_HTTP === "1" ||
      process.env.NODE_ENV === "test",
  });

  return cachedHandler;
}
