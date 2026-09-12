/**
 * Audit Turnkey sub-orgs vs PymtHouse users, optionally backfill placeholder
 * emails, and print the known-duplicate cleanup / Turnkey escalation text.
 *
 * Usage:
 *   npx tsx scripts/turnkey-identity-audit.ts
 *   npx tsx scripts/turnkey-identity-audit.ts --backfill
 *   npx tsx scripts/turnkey-identity-audit.ts --backfill --apply
 *   npx tsx scripts/turnkey-identity-audit.ts --cleanup-report
 *   npx tsx scripts/turnkey-identity-audit.ts --escalate
 *
 * Required env:
 *   TURNKEY_ORG_ID or NEXT_PUBLIC_ORGANIZATION_ID
 *   TURNKEY_API_PUBLIC_KEY
 *   TURNKEY_API_PRIVATE_KEY
 *   DATABASE_URL (for --backfill / --cleanup-report)
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

const KNOWN_DELETE_SUBORGS = [
  {
    organizationId: "333b8bdd-cabb-477a-b8dc-1bfca05e48e3",
    email: "qiang@livepeer.org",
    turnkeyUserId: "b109d006-906c-4f35-84b3-daaec5acfaef",
    pymthouseUserId: "d3642304-31c5-43e9-9ed3-03eaad84964b",
    action: "remap-after-google-relogin",
  },
  {
    organizationId: "6b9443d8-b9d3-4061-a7ea-efac680a1bb5",
    email: "mazup.x@gmail.com",
    turnkeyUserId: "ce3a9094-5aaa-4a48-88eb-86a48ae9ed29",
    pymthouseUserId: "47898277-5d0e-4ea4-8a0c-cb17b99c55b2",
    action: "remap-after-google-relogin",
  },
] as const;

const DO_NOT_DELETE_WALLETS = [
  "a60a3bb6-b44a-46aa-8086-8d75df31628c",
  "84ec5822-afef-483b-8d08-6b6df8d117ad",
] as const;

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

async function listSubOrgIds(
  client: ReturnType<typeof getTurnkeyServerApiClient>,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await client.getSubOrgIds({
      organizationId: PARENT_ORG_ID,
      paginationOptions: {
        limit: "100",
        ...(after ? { after } : {}),
      },
    });
    const batch = result.organizationIds ?? [];
    if (batch.length === 0) break;
    ids.push(...batch);
    if (batch.length < 100) break;
    after = batch[batch.length - 1];
  }
  return ids;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("Resource exhausted") && !message.includes("error 8")) {
        throw err;
      }
      const waitMs = 1500 * (attempt + 1);
      console.warn(`${label}: rate-limited, retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
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

function printEscalate(): void {
  console.log(`To: help@turnkey.com (or Turnkey dashboard support chat)

Turnkey social-linking defect

Parent organization: 4a6a9098-0f08-480f-b3a8-a8e1fbd5103e
Affected sub-organization: 333b8bdd-cabb-477a-b8dc-1bfca05e48e3
Verified email: qiang@livepeer.org (present, no OAuth providers registered)
Second confirmed case: 6b9443d8-b9d3-4061-a7ea-efac680a1bb5 / mazup.x@gmail.com

Repro:
1. User previously authenticated with email OTP, creating a verified-email sub-org with no OAuth providers.
2. User clicks Continue with Google on pymthouse.com (Auth Proxy config c9bd2043-4849-4af0-8224-b31480d3ea51).
3. Auth Proxy resolves the Google token to the verified-email sub-org.
4. Attested-stamp OAuth login fails with Turnkey error 16 / PUBLIC_KEY_NOT_FOUND:
   "no user found for attested identity organizationId=333b8bdd-…"

We are on @turnkey/core 2.8.1 / @turnkey/react-wallet-kit 2.4.3, which already
contains tkhq/sdk#1503 (pass organizationId from get_accounts into loginWithOauth).
This is a separate defect: documented social-linking case 2 says the first Google
login should auto-add the Google provider to the matching verified email. It is
not firing on the attested-stamp login path.

Questions:
1. Is case-2 auto-linking skipped on the attested-stamp / Auth Proxy login path?
2. Can GitHub be supported as an OAuth 2.0-only provider so we can retire our
   BYO OIDC path and have a single sub-org creation authority?
`);
}

function printCleanupReport(): void {
  const deleteLines = KNOWN_DELETE_SUBORGS.map(
    (row) =>
      `- ${row.organizationId} (${row.email}) → ${row.action} ${row.pymthouseUserId}`,
  ).join("\n");
  console.log(`Known-duplicate cleanup (do not pass deleteWithoutExport on wallet sub-orgs)

Delete targets (wallets: [] — deleteWithoutExport: true is safe):
${deleteLines}

Do NOT delete:
- ${DO_NOT_DELETE_WALLETS.join("\n- ")}

ACTIVITY_TYPE_DELETE_SUB_ORGANIZATION must be stamped by a root user inside
the target sub-org. From an email-OTP session in that sub-org:

  client.deleteSubOrganization({
    organizationId: "<subOrgId>",
    deleteWithoutExport: true,
  })

Or send both IDs plus parent 4a6a9098-0f08-480f-b3a8-a8e1fbd5103e to Turnkey support.

PymtHouse rows (production dawn-shape-62725766):
- d3642304-31c5-43e9-9ed3-03eaad84964b (turnkey b109d006-…) is NOT an orphan.
  It owns Livepeer Agent (app_98575870d7ae33589a3f0660), a provider_admins owner
  row, and billing_customers 98e401d5-… (OpenMeter 01KXKY4GXFQ40PV96GW8WGCFFB).
  Do not delete this row. After Google re-login, remap turnkey_user_id + email
  if the new Turnkey user id differs. Keep c5561cfc-… as the separate GitHub identity.
- 47898277-5d0e-4ea4-8a0c-cb17b99c55b2 (turnkey ce3a9094-…) — Mazup's only row.
  Has billing_customers 06439adb-… on app_a064f35388c747fb374191d9.
  Remap turnkey_user_id + email after the post-cleanup Google login; do not delete.
`);
}

async function main(): Promise<void> {
  if (hasFlag("--escalate")) {
    printEscalate();
    return;
  }
  if (hasFlag("--cleanup-report")) {
    printCleanupReport();
    return;
  }

  if (!PARENT_ORG_ID) {
    throw new Error("Missing TURNKEY_ORG_ID / NEXT_PUBLIC_ORGANIZATION_ID");
  }

  const client = getTurnkeyServerApiClient();
  const subOrgIds = await listSubOrgIds(client);
  const records: SubOrgRecord[] = [];
  for (const organizationId of subOrgIds) {
    records.push(await inspectSubOrg(client, organizationId));
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
    if (apply) {
      await db.update(users).set({ email: nextEmail }).where(eq(users.id, row.id));
    }
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
