/**
 * Repair an owner customer that has no `usageAttribution.subjectKeys`.
 *
 * Konnect refuses subject-key changes while a subscription is active, and
 * `ensureCustomerUsageAttribution` deliberately returns early in that case
 * rather than eating a 400. So a customer that reaches this state cannot be
 * fixed in place: the subscription must be cancelled, the keys attached, and
 * the subscription re-created.
 *
 * Surfaced by `customer_has_no_usage_attribution` in
 * `openmeter-audit-billing-consistency`. Until it is fixed, that owner's usage
 * is metered but can never be invoiced.
 *
 * DESTRUCTIVE: `--apply` cancels a live subscription. There is a window between
 * cancel and re-provision in which the owner's spendable gate reads 0 and the
 * signer returns 483. Run it deliberately, not casually.
 *
 * Every step is verified before the next begins. If attribution does not take,
 * the script aborts *before* re-provisioning rather than continuing blind —
 * leaving the subscription cancelled is recoverable by re-running; leaving the
 * customer unattributed with a fresh lock is not.
 *
 * Usage:
 *   npx tsx scripts/openmeter-fix-owner-attribution.ts --owner-id <users.id>
 *   npx tsx scripts/openmeter-fix-owner-attribution.ts --owner-id <users.id> --apply
 */
import "./load-env-first";

import { eq } from "drizzle-orm";

import { closeDb, db } from "../src/db/index";
import { developerApps, oidcClients } from "../src/db/schema";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import {
  ensureOwnerCustomer,
  findOpenMeterCustomerByKey,
} from "../src/lib/openmeter/customers";
import { cancelKonnectSubscription } from "../src/lib/openmeter/konnect-subscriptions";
import { ensureOwnerStarterSubscription } from "../src/lib/openmeter/owner-starter-plan";
import { buildOwnerCustomerKey } from "../src/lib/openmeter/customer-key";

/** Subscription statuses that block subject-key changes in Konnect. */
const LOCKING_STATUSES = new Set(["active", "scheduled", "pending"]);
const SETTLE_POLL_ATTEMPTS = 10;
const SETTLE_POLL_MS = 2_000;

function takeArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const ownerId = takeArg("--owner-id")?.trim();
  const apply = process.argv.includes("--apply");
  if (!ownerId) {
    console.error("usage: --owner-id <users.id> [--apply]");
    process.exitCode = 1;
    return;
  }
  if (!isHostedAdminClientAvailable()) {
    console.error("OpenMeter admin client unavailable (check OPENMETER_URL / OPENMETER_API_KEY)");
    process.exitCode = 1;
    return;
  }

  const client = getHostedAdminClient();
  const customerKey = buildOwnerCustomerKey(ownerId);

  const customer = (await findOpenMeterCustomerByKey(client, customerKey)) as
    | { id?: string; usageAttribution?: { subjectKeys?: string[] } }
    | null;
  if (!customer?.id) {
    console.error(`No OpenMeter customer for key ${customerKey}`);
    process.exitCode = 1;
    return;
  }
  const customerId = customer.id;

  const readAttribution = async (): Promise<string[]> => {
    const fresh = (await findOpenMeterCustomerByKey(client, customerKey)) as
      | { usageAttribution?: { subjectKeys?: string[] } }
      | null;
    return fresh?.usageAttribution?.subjectKeys ?? [];
  };
  const readLocking = async (): Promise<Array<{ id: string; status: string }>> => {
    const listed = await client.customers.listSubscriptions(customerId, {
      pageSize: 100,
    });
    return (listed?.items ?? [])
      .map((item) => ({
        id: (item as { id?: string }).id ?? "",
        status: (item as { status?: string }).status ?? "",
      }))
      .filter((item) => LOCKING_STATUSES.has(item.status));
  };

  const attribution = await readAttribution();
  const locking = await readLocking();
  console.log(`owner=${ownerId} customer=${customerId}`);
  console.log(`  attribution: ${attribution.length > 0 ? attribution.join(", ") : "(none)"}`);
  const lockingSummary =
    locking.map((s) => s.id + "(" + s.status + ")").join(", ") || "(none)";
  console.log(`  locking subscriptions: ${lockingSummary}`);

  if (attribution.length > 0) {
    console.log("Nothing to do — customer already has attributed subjects.");
    return;
  }

  const appRows = await db
    .select({ publicClientId: oidcClients.clientId })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.ownerId, ownerId));
  const publicClientIds = appRows
    .map((row) => row.publicClientId?.trim())
    .filter((id): id is string => Boolean(id));

  if (!apply) {
    console.log("\n[dry-run] would:");
    for (const sub of locking) {
      console.log(`  1. cancel subscription ${sub.id} (${sub.status}) — immediate`);
    }
    console.log(`  2. attach settlement subject ${customerKey} (${publicClientIds.length} apps known)`);
    console.log("  3. re-provision Owner Starter");
    console.log("\nRe-run with --apply to perform this. It cancels a live subscription.");
    return;
  }

  for (const sub of locking) {
    console.log(`cancelling ${sub.id} (immediate)…`);
    await cancelKonnectSubscription({ subscriptionId: sub.id, timing: "immediate" });
  }

  // Konnect is not reliably read-your-writes here; poll rather than assume.
  let remaining = await readLocking();
  for (let i = 0; i < SETTLE_POLL_ATTEMPTS && remaining.length > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    remaining = await readLocking();
  }
  if (remaining.length > 0) {
    throw new Error(
      `Subscriptions still locking after cancel (${remaining
        .map((s) => `${s.id}(${s.status})`)
        .join(", ")}). Not attaching keys; re-run once they settle.`,
    );
  }

  console.log(`attaching settlement subject for ${publicClientIds.length} apps…`);
  await ensureOwnerCustomer(client, ownerId, publicClientIds);

  const attached = await readAttribution();
  if (attached.length === 0) {
    throw new Error(
      "Attribution still empty after attach. Re-provision skipped deliberately: " +
        "a new subscription would re-lock the keys and block a retry.",
    );
  }
  console.log(`  attribution now: ${attached.join(", ")}`);

  console.log("re-provisioning Owner Starter…");
  const ensured = await ensureOwnerStarterSubscription({
    ownerUserId: ownerId,
    publicClientIds,
  });
  console.log(`  subscription=${ensured.openmeterSubscriptionId} created=${ensured.created}`);

  console.log("\ndone — re-run openmeter:audit-billing to confirm.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
