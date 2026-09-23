import { getPublicOrigin } from "@/platform/oidc/issuer-urls";

export async function getTrustedOidcOrigins(): Promise<Set<string>> {
  const publicOrigin = getPublicOrigin();
  const { getTrustedLoginHosts } = await import("@/domains/oidc-platform/runtime/custom-domains");
  const trustedHosts = await getTrustedLoginHosts();

  const origins = new Set<string>();
  origins.add(new URL(publicOrigin).origin);

  for (const host of trustedHosts) {
    if (host.includes("localhost") || host.startsWith("127.")) {
      origins.add(`http://${host}`);
    } else {
      origins.add(`https://${host}`);
    }
  }

  return origins;
}
