import type { Session } from "next-auth";

import { setProviderAppSessionResolverForTests } from "@/lib/provider-apps";

export function installProviderAppSessionAuth(
  getAuthorizedApp: () => { userId: string } | null,
): void {
  setProviderAppSessionResolverForTests(async () => {
    const app = getAuthorizedApp();
    if (!app) return null;
    return {
      user: {
        id: app.userId,
        role: "developer",
      },
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    } as Session;
  });
}

export function uninstallProviderAppSessionAuth(): void {
  setProviderAppSessionResolverForTests(null);
}
