import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import {
  enabledSigningBackendsFromMode,
  type SigningBackend,
} from "@/lib/signing-modes";

export interface CachedAppSigningRouting {
  publicClientId: string;
  providerAppId: string;
  signingMode: string;
  enabledBackends: SigningBackend[];
  payerDaemonSocket: string | null;
  updatedAt: number;
}

const cacheByPublicClientId = new Map<string, CachedAppSigningRouting>();

export function getCachedAppSigningRouting(
  publicClientId: string,
): CachedAppSigningRouting | undefined {
  return cacheByPublicClientId.get(publicClientId);
}

export function publishCachedAppSigningRouting(
  entry: CachedAppSigningRouting,
): CachedAppSigningRouting {
  cacheByPublicClientId.set(entry.publicClientId, entry);
  return entry;
}

export function resetSigningRoutingCacheForTests(): void {
  cacheByPublicClientId.clear();
}

export async function warmAppSigningRoutingCache(
  publicClientId: string,
): Promise<CachedAppSigningRouting | null> {
  const trimmed = publicClientId.trim();
  if (!trimmed) return null;

  const byOidc = await db
    .select({
      id: developerApps.id,
      signingMode: developerApps.signingMode,
      payerDaemonSocket: developerApps.payerDaemonSocket,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, trimmed))
    .limit(1);

  const row = byOidc[0];
  if (!row) return null;

  const signingMode = row.signingMode ?? "legacy_remote_signer";
  return publishCachedAppSigningRouting({
    publicClientId: trimmed,
    providerAppId: row.id,
    signingMode,
    enabledBackends: enabledSigningBackendsFromMode(signingMode),
    payerDaemonSocket: row.payerDaemonSocket ?? null,
    updatedAt: Date.now(),
  });
}
