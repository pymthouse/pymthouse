/**
 * Dry-run report for duplicate PymtHouse emails.
 *
 *   npx tsx scripts/turnkey-identity-consolidate.ts
 *
 * Does not delete rows. Moving apps and deleting an empty login is done in
 * the admin app-owner UI and /account after the wallet issuer is live.
 */
import "./load-env-first";
import { closeDb, db } from "../src/db/index";
import { users } from "../src/db/schema";
import { isPlaceholderTurnkeyEmail, normalizeTurnkeyEmail } from "../src/lib/turnkey";

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      turnkeyUserId: users.turnkeyUserId,
      turnkeySubOrgId: users.turnkeySubOrgId,
      createdAt: users.createdAt,
    })
    .from(users);

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const email = normalizeTurnkeyEmail(row.email);
    if (!email || isPlaceholderTurnkeyEmail(row.email, row.turnkeyUserId ?? "")) continue;
    const list = groups.get(email) ?? [];
    list.push(row);
    groups.set(email, list);
  }

  const duplicates = [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([email, list]) => ({
      email,
      rows: list.map((row) => ({
        id: row.id,
        turnkeyUserId: row.turnkeyUserId,
        turnkeySubOrgId: row.turnkeySubOrgId,
        createdAt: row.createdAt,
      })),
    }));

  const placeholders = rows.filter((row) =>
    isPlaceholderTurnkeyEmail(row.email, row.turnkeyUserId ?? ""),
  ).length;

  console.log(
    JSON.stringify(
      {
        duplicateEmailGroups: duplicates,
        placeholderOrMissingEmailRows: placeholders,
        note: "No rows were changed. Sync sub-org ids with npm run turnkey:identity-audit -- --sync --apply after the wallet-issuer migration is deployed.",
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
