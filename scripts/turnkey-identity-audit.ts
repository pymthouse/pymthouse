/**
 * Audit Turnkey sub-orgs vs PymtHouse users and optionally backfill placeholder
 * emails.
 *
 * Usage:
 *   npx tsx scripts/turnkey-identity-audit.ts
 *   npx tsx scripts/turnkey-identity-audit.ts --backfill
 *   npx tsx scripts/turnkey-identity-audit.ts --backfill --apply
 *
 * Required env:
 *   TURNKEY_ORG_ID or NEXT_PUBLIC_ORGANIZATION_ID
 *   TURNKEY_API_PUBLIC_KEY
 *   TURNKEY_API_PRIVATE_KEY
 *   DATABASE_URL (for --backfill)
 */
import "./load-env-first";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/db/index";
import { users } from "../src/db/schema";
import { getTurnkeyServerApiClient } from "../src/lib/onramp/turnkey-client";
import {
  isPlaceholderTurnkeyEmail,
  normalizeTurnkeyEmail,
} from "../src/lib/turnkey";

const PARENT_ORG_ID =
  process.env.TURNKEY_ORG_ID?.trim() ||
  process.env.NEXT_PUBLIC_ORGANIZATION_ID?.trim() ||
  "";

type SubOrgRecord = {
  organizationId: string;
  userId: string | null;
  email: string | null;
  oauthCount: number;
  walletCount: number;
  providerNames: string[];
};

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

type TurnkeyAuditClient = ReturnType<typeof getTurnkeyServerApiClient>;

async function listSubOrgPage(
  client: TurnkeyAuditClient,
  ids: string[],
  after: string | undefined,
  pagesLeft: number,
): Promise<string[]> {
  if (pagesLeft <= 0) return ids;
  const result = await client.getSubOrgIds({
    organizationId: PARENT_ORG_ID,
    paginationOptions: {
      limit: "100",
      ...(after ? { after } : {}),
    },
  });
  const batch = result.organizationIds ?? [];
  const fresh = batch.filter((id) => !ids.includes(id));
  if (batch.length === 0 || fresh.length === 0 || batch.length < 100) {
    ids.push(...fresh);
    return ids;
  }
  ids.push(...fresh);
  return listSubOrgPage(client, ids, fresh.at(-1), pagesLeft - 1);
}

function listSubOrgIds(client: TurnkeyAuditClient): Promise<string[]> {
  return listSubOrgPage(client, [], undefined, 100);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRateLimit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Resource exhausted") || message.includes("error 8");
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempt = 0,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (attempt >= 4 || !isRateLimit(err)) throw err;
    const waitMs = 1500 * (attempt + 1);
    console.warn(`${label}: rate-limited, retrying in ${waitMs}ms`);
    await sleep(waitMs);
    return withRetry(label, fn, attempt + 1);
  }
}

async function inspectSubOrg(
  client: TurnkeyAuditClient,
  organizationId: string,
): Promise<SubOrgRecord> {
  const usersResult = await withRetry(`getUsers ${organizationId}`, () =>
    client.getUsers({ organizationId }),
  );
  await sleep(80);
  const walletsResult = await withRetry(`getWallets ${organizationId}`, () =>
    client.getWallets({ organizationId }),
  );
  const user = usersResult.users?.[0];
  return {
    organizationId,
    userId: user?.userId ?? null,
    email: user?.userEmail?.trim() || null,
    oauthCount: user?.oauthProviders?.length ?? 0,
    walletCount: walletsResult.wallets?.length ?? 0,
    providerNames: (user?.oauthProviders ?? []).map((p) => p.providerName),
  };
}

function isAppRootEmail(email: string | null): boolean {
  return !!email?.includes("@example.com") || !!email?.startsWith("turnkey-root+");
}

function printInventory(records: SubOrgRecord[]): void {
  const emailOnly = records.filter((r) => r.email && r.oauthCount === 0);
  const humanEmailOnly = emailOnly.filter((r) => !isAppRootEmail(r.email));
  const appRootEmailOnly = emailOnly.filter((r) => isAppRootEmail(r.email));
  console.log(
    JSON.stringify(
      {
        parentOrganizationId: PARENT_ORG_ID,
        subOrgCount: records.length,
        withOauth: records.filter((r) => r.oauthCount > 0).length,
        withWallets: records.filter((r) => r.walletCount > 0).length,
        verifiedEmailNoOauth: emailOnly.length,
        humanVerifiedEmailNoOauth: humanEmailOnly.length,
        appRootVerifiedEmailNoOauth: appRootEmailOnly.length,
        humanVerifiedEmailNoOauthList: humanEmailOnly,
      },
      null,
      2,
    ),
  );
}

async function collectRecords(
  client: TurnkeyAuditClient,
  organizationIds: string[],
  index = 0,
  records: SubOrgRecord[] = [],
): Promise<SubOrgRecord[]> {
  const organizationId = organizationIds[index];
  if (!organizationId) return records;
  records.push(await inspectSubOrg(client, organizationId));
  return collectRecords(client, organizationIds, index + 1, records);
}

async function printSyncReport(records: SubOrgRecord[]): Promise<void> {
  const apply = hasFlag("--apply") && hasFlag("--sync");
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      turnkeyUserId: users.turnkeyUserId,
      turnkeySubOrgId: users.turnkeySubOrgId,
    })
    .from(users);
  const syncs = rows.flatMap((row) => {
    if (!row.turnkeyUserId || row.turnkeySubOrgId) return [];
    const match = records.find((record) => record.userId === row.turnkeyUserId);
    if (!match) return [];
    return [{ id: row.id, turnkeySubOrgId: match.organizationId }];
  });
  if (apply) {
    await Promise.all(
      syncs.map((sync) =>
        db
          .update(users)
          .set({ turnkeySubOrgId: sync.turnkeySubOrgId })
          .where(eq(users.id, sync.id)),
      ),
    );
  }
  const duplicateEmails = new Map<string, string[]>();
  for (const row of rows) {
    const email = normalizeTurnkeyEmail(row.email);
    if (!email || isPlaceholderTurnkeyEmail(row.email, row.turnkeyUserId ?? "")) continue;
    const list = duplicateEmails.get(email) ?? [];
    list.push(row.id);
    duplicateEmails.set(email, list);
  }
  console.log(
    JSON.stringify(
      {
        apply,
        subOrgSync: syncs,
        duplicateEmails: [...duplicateEmails.entries()]
          .filter(([, ids]) => ids.length > 1)
          .map(([email, userIds]) => ({ email, userIds })),
        walletIssuerCount: records.filter((record) =>
          record.providerNames.some((name) => name.toLowerCase() === "pymthouse"),
        ).length,
      },
      null,
      2,
    ),
  );
}

async function backfillPlaceholders(records: SubOrgRecord[]): Promise<void> {
  const apply = hasFlag("--apply");
  const placeholderRows = await db
    .select({
      id: users.id,
      email: users.email,
      turnkeyUserId: users.turnkeyUserId,
    })
    .from(users);
  const updates = placeholderRows.flatMap((row) => {
    if (!row.turnkeyUserId) return [];
    if (!isPlaceholderTurnkeyEmail(row.email, row.turnkeyUserId)) return [];
    const match = records.find((record) => record.userId === row.turnkeyUserId);
    const nextEmail = normalizeTurnkeyEmail(match?.email);
    if (!nextEmail) return [];
    return [
      {
        id: row.id,
        from: row.email,
        to: nextEmail,
        turnkeyUserId: row.turnkeyUserId,
      },
    ];
  });
  if (apply) {
    await Promise.all(
      updates.map((update) =>
        db.update(users).set({ email: update.to }).where(eq(users.id, update.id)),
      ),
    );
  }
  console.log(JSON.stringify({ apply, placeholderUpdates: updates }, null, 2));
}

async function main(): Promise<void> {
  if (!PARENT_ORG_ID) {
    throw new Error("Missing TURNKEY_ORG_ID / NEXT_PUBLIC_ORGANIZATION_ID");
  }
  const client = getTurnkeyServerApiClient();
  const records = await collectRecords(client, await listSubOrgIds(client));
  printInventory(records);
  if (hasFlag("--sync") || hasFlag("--backfill")) {
    await printSyncReport(records);
  }
  if (hasFlag("--backfill")) {
    await backfillPlaceholders(records);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
