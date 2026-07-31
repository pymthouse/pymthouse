import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { apiKeys, appUsers, developerApps, oidcClients } from "@/db/schema";
import {
  queryOpenMeterIdentityTotals,
  type OpenMeterIdentityTotalsRow,
} from "@/lib/usage/query-openmeter";

/** API key bound to an identity (`api_keys.app_user_id`). */
export type IdentityApiKeySummary = {
  id: string;
  label: string | null;
  keyPrefix: string | null;
  status: string;
};

/**
 * One M2M identity on an app, joined across its three sources of truth:
 * OpenMeter cycle totals, the `app_users` provisioning row, and its API keys.
 */
export type AppIdentityRow = {
  /** Meter `external_user_id` — the identity's stable billing key. */
  externalUserId: string;
  /** `app_users.id`; null when the identity exists only in meter data. */
  appUserId: string | null;
  label: string;
  email: string | null;
  status: string;
  /**
   * False when the identity appears in meter data but has no `app_users` row
   * (e.g. an OIDC subject that transacted before provisioning). Such rows are
   * still billable, so they must stay visible.
   */
  provisioned: boolean;
  /** Most recently created non-revoked key, else the most recent key. */
  apiKey: IdentityApiKeySummary | null;
  apiKeyCount: number;
  requestCount: number;
  networkFeeUsdMicros: string;
  billableSecs: string;
  lastActiveDate: string | null;
  createdAt: string | null;
};

type AppUserRecord = {
  id: string;
  externalUserId: string;
  email: string | null;
  status: string;
  createdAt: string;
};

type ApiKeyRecord = {
  id: string;
  appUserId: string | null;
  label: string | null;
  keyPrefix: string | null;
  status: string;
  createdAt: string;
  revokedAt: string | null;
};

function compareUsdMicrosDesc(a: string, b: string): number {
  try {
    const left = BigInt(a || "0");
    const right = BigInt(b || "0");
    if (left === right) return 0;
    return right > left ? 1 : -1;
  } catch {
    return 0;
  }
}

/** Fee desc, then requests desc, then identity id for a stable order. */
export function sortIdentityRowsByFeeDesc(rows: AppIdentityRow[]): AppIdentityRow[] {
  return [...rows].sort((a, b) => {
    const byFee = compareUsdMicrosDesc(a.networkFeeUsdMicros, b.networkFeeUsdMicros);
    if (byFee !== 0) return byFee;
    if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
    return a.externalUserId.localeCompare(b.externalUserId);
  });
}

/** Prefer an active key; fall back to the newest key so the column is never blank. */
function pickPrimaryApiKey(keys: ApiKeyRecord[]): IdentityApiKeySummary | null {
  if (keys.length === 0) return null;
  const byNewest = [...keys].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = byNewest.find((key) => key.status === "active" && !key.revokedAt);
  const chosen = active ?? byNewest[0];
  return {
    id: chosen.id,
    label: chosen.label,
    keyPrefix: chosen.keyPrefix,
    status: chosen.revokedAt ? "revoked" : chosen.status,
  };
}

/**
 * Merge meter identities with provisioning rows and API keys.
 *
 * Union semantics in both directions: metered-but-unprovisioned identities stay
 * visible (they are billable), and provisioned-but-idle identities stay visible
 * with zeroed usage (they are still identities).
 */
export function buildAppIdentityRows(input: {
  meterRows: OpenMeterIdentityTotalsRow[];
  appUsers: AppUserRecord[];
  apiKeys: ApiKeyRecord[];
}): AppIdentityRow[] {
  const appUserByExternalId = new Map(
    input.appUsers.map((user) => [user.externalUserId, user]),
  );

  const keysByAppUserId = new Map<string, ApiKeyRecord[]>();
  for (const key of input.apiKeys) {
    if (!key.appUserId) continue;
    const list = keysByAppUserId.get(key.appUserId) ?? [];
    list.push(key);
    keysByAppUserId.set(key.appUserId, list);
  }

  const meterByExternalId = new Map(
    input.meterRows.map((row) => [row.externalUserId, row]),
  );

  const externalUserIds = new Set([
    ...meterByExternalId.keys(),
    ...appUserByExternalId.keys(),
  ]);

  const rows: AppIdentityRow[] = [...externalUserIds].map((externalUserId) => {
    const meter = meterByExternalId.get(externalUserId);
    const appUser = appUserByExternalId.get(externalUserId);
    const keys = appUser ? (keysByAppUserId.get(appUser.id) ?? []) : [];

    return {
      externalUserId,
      appUserId: appUser?.id ?? null,
      label: externalUserId,
      email: appUser?.email ?? null,
      status: appUser?.status ?? "unprovisioned",
      provisioned: Boolean(appUser),
      apiKey: pickPrimaryApiKey(keys),
      apiKeyCount: keys.length,
      requestCount: meter?.requestCount ?? 0,
      networkFeeUsdMicros: meter?.networkFeeUsdMicros ?? "0",
      billableSecs: meter?.billableSecs ?? "0",
      lastActiveDate: meter?.lastActiveDate ?? null,
      createdAt: appUser?.createdAt ?? null,
    };
  });

  return sortIdentityRowsByFeeDesc(rows);
}

/**
 * Public OIDC `client_id` (`app_…`) for a developer app — the id signed-ticket
 * event queries expect. Falls back to `developer_apps.id` for legacy apps
 * whose events were written before an OIDC client existed.
 */
export async function resolveAppPublicClientId(appId: string): Promise<string> {
  const rows = await db
    .select({ clientId: oidcClients.clientId })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.id, appId))
    .limit(1);
  return rows[0]?.clientId?.trim() || appId;
}

/**
 * Identities for one app over a billing cycle, sorted by network fee desc.
 * `clientId` is `developer_apps.id` (the meter client id is resolved downstream).
 */
export async function listAppIdentities(input: {
  clientId: string;
  startDate: string;
  endDate: string;
}): Promise<AppIdentityRow[]> {
  const [meterRows, appUserRows, apiKeyRows] = await Promise.all([
    queryOpenMeterIdentityTotals({
      clientId: input.clientId,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch((err) => {
      console.warn(
        "identity-rollup: OpenMeter identity totals failed",
        input.clientId,
        err instanceof Error ? err.message : String(err),
      );
      return [] as OpenMeterIdentityTotalsRow[];
    }),
    db
      .select({
        id: appUsers.id,
        externalUserId: appUsers.externalUserId,
        email: appUsers.email,
        status: appUsers.status,
        createdAt: appUsers.createdAt,
      })
      .from(appUsers)
      .where(eq(appUsers.clientId, input.clientId)),
    db
      .select({
        id: apiKeys.id,
        appUserId: apiKeys.appUserId,
        label: apiKeys.label,
        keyPrefix: apiKeys.keyPrefix,
        status: apiKeys.status,
        createdAt: apiKeys.createdAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.clientId, input.clientId)),
  ]);

  return buildAppIdentityRows({
    meterRows,
    appUsers: appUserRows,
    apiKeys: apiKeyRows,
  });
}
