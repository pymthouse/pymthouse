import { and, eq } from "drizzle-orm";

import { db } from "@/db/index";
import { appUsers } from "@/db/schema";
import { buildDiscoverOrchestratorsUrl } from "@/lib/discovery-service-url";
import { getClientSignerApiUrl } from "@/lib/signer-proxy";

/**
 * Parse an optional discoveryUrl preference from a users API body.
 * - omitted → no change
 * - null / "" / whitespace → clear (null)
 * - non-empty → must be absolute http(s) URL
 */
export function parseDiscoveryUrlPreference(
  value: unknown,
):
  | { ok: true; present: false }
  | { ok: true; present: true; discoveryUrl: string | null }
  | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, present: false };
  }
  if (value === null) {
    return { ok: true, present: true, discoveryUrl: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "discoveryUrl must be a string or null" };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, present: true, discoveryUrl: null };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: "discoveryUrl must be an absolute http(s) URL",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: "discoveryUrl must be an absolute http(s) URL",
    };
  }
  return { ok: true, present: true, discoveryUrl: trimmed };
}

/** Load the stored discovery URL preference for an app user identity. */
export async function loadAppUserDiscoveryUrl(input: {
  appId: string;
  externalUserId: string;
}): Promise<string | undefined> {
  const rows = await db
    .select({ discoveryUrl: appUsers.discoveryUrl })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, input.appId),
        eq(appUsers.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);
  const value = rows[0]?.discoveryUrl?.trim();
  return value || undefined;
}

/**
 * Resolve SignerSession.discovery_url:
 * request override → user preference → derive from signer_url / app signer.
 */
export function resolveSignerSessionDiscoveryUrl(input: {
  requestOverride?: string | null;
  userPreference?: string | null;
  publicClientId?: string | null;
  signerUrl?: string | null;
}): string | undefined {
  const override = input.requestOverride?.trim();
  if (override) return override;

  const preference = input.userPreference?.trim();
  if (preference) return preference;

  const signerUrl = (
    input.signerUrl?.trim() ||
    getClientSignerApiUrl(input.publicClientId).trim()
  );
  if (!signerUrl) return undefined;
  try {
    return buildDiscoverOrchestratorsUrl(signerUrl);
  } catch {
    return undefined;
  }
}
