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

async function listSubOrgPage(
  client: ReturnType<typeof getTurnkeyServerApiClient>,
  after: string | undefined,
  page: number,
): Promise<string[]> {
  if (page >= 100) return [];
  const result = await client.getSubOrgIds({
    organizationId: PARENT_ORG_ID,
    paginationOptions: {
      limit: "100",
      ...(after ? { after } : {}),
    },
  });
  const batch = result.organizationIds ?? [];
  if (batch.length === 0 || batch.length < 100) return batch;
  const rest = await listSubOrgPage(client, batch.at(-1), page + 1);
  return batch.concat(rest);
}

async function listSubOrgIds(
  client: ReturnType<typeof getTurnkeyServerApiClient>,
): Promise<string[]> {
  return listSubOrgPage(client, undefined, 0);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRateLimited(err: unknown): boolean {
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
    if (!isRateLimited(err) || attempt >= 4) throw err;
    const waitMs = 1500 * (attempt + 1);
    console.warn(`${label}: rate-limited, retrying in ${waitMs}ms`);
    await sleep(waitMs);
    return withRetry(label, fn, attempt + 1);
  }
}

async function inspectSubOrg(
  client: ReturnType<typeof getTurnkeyServerApiClient>,
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

async function* inspectSubOrgs(
  client: ReturnType<typeof getTurnkeyServerApiClient>,
  organizationIds: string[],
): AsyncGenerator<SubOrgRecord> {
  for (const organizationId of organizationIds) {
    yield inspectSubOrg(client, organizationId);
  }
}

async function main(): Promise<void> {
  if (!PARENT_ORG_ID) {
    throw new Error("Missing TURNKEY_ORG_ID / NEXT_PUBLIC_ORGANIZATION_ID");
  }

  const client = getTurnkeyServerApiClient();
  const subOrgIds = await listSubOrgIds(client);
  const records: SubOrgRecord[] = [];
  for await (const record of inspectSubOrgs(client, subOrgIds)) {
    records.push(record);
  }

  const emailOnly = records.filter((r) => r.email && r.oauthCount === 0);
  const humanEmailOnly = emailOnly.filter(
    (r) =>
      !r.email?.includes("@example.com") &&
      !r.email?.startsWith("turnkey-root+"),
  );
  const appRootEmailOnly = emailOnly.filter(
    (r) =>
      !!r.email?.includes("@example.com") ||
      !!r.email?.startsWith("turnkey-root+"),
  );
  const withOauth = records.filter((r) => r.oauthCount > 0);
  const withWallets = records.filter((r) => r.walletCount > 0);

  console.log(
    JSON.stringify(
      {
        parentOrganizationId: PARENT_ORG_ID,
        subOrgCount: records.length,
        withOauth: withOauth.length,
        withWallets: withWallets.length,
        verifiedEmailNoOauth: emailOnly.length,
        humanVerifiedEmailNoOauth: humanEmailOnly.length,
        appRootVerifiedEmailNoOauth: appRootEmailOnly.length,
        humanVerifiedEmailNoOauthList: humanEmailOnly,
      },
      null,
      2,
    ),
  );

  if (!hasFlag("--backfill")) return;

  const apply = hasFlag("--apply");
  const placeholderRows = await db
    .select({
      id: users.id,
      email: users.email,
      turnkeyUserId: users.turnkeyUserId,
    })
    .from(users);

  const updates: Array<{
    id: string;
    from: string | null;
    to: string;
    turnkeyUserId: string;
  }> = [];
  for (const row of placeholderRows) {
    if (!row.turnkeyUserId) continue;
    if (!isPlaceholderTurnkeyEmail(row.email, row.turnkeyUserId)) continue;
    const match = records.find((r) => r.userId === row.turnkeyUserId);
    const nextEmail = normalizeTurnkeyEmail(match?.email);
    if (!nextEmail) continue;
    updates.push({
      id: row.id,
      from: row.email,
      to: nextEmail,
      turnkeyUserId: row.turnkeyUserId,
    });
  }

  if (apply) {
    await Promise.all(
      updates.map((update) =>
        db.update(users).set({ email: update.to }).where(eq(users.id, update.id)),
      ),
    );
  }

  console.log(
    JSON.stringify(
      {
        apply,
        placeholderUpdates: updates,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
