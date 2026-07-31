/**
 * Migrate OpenMeter customers off Sandbox billing profiles onto Stripe profiles.
 *
 * For each customer: ensure Stripe customer app data (cus_…, no card), then pin
 * to the app (or owners) Stripe billing profile. End users without a paid
 * subscription are left on the free profile that Starter requires.
 *
 * Usage:
 *   npx tsx scripts/openmeter-migrate-sandbox-to-stripe.ts
 *   npx tsx scripts/openmeter-migrate-sandbox-to-stripe.ts --apply
 *   npx tsx scripts/openmeter-migrate-sandbox-to-stripe.ts --client-id app_xxx --apply
 *   npx tsx scripts/openmeter-migrate-sandbox-to-stripe.ts --owners-only --apply
 */
import "./load-env-first";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/db/index";
import { appUsers, developerApps, users } from "../src/db/schema";
import {
  ensureAppStripeBillingReady,
  ensureOwnersBillingProfile,
  prepareAppCustomerStripeBilling,
  prepareOwnerCustomerStripeBilling,
} from "../src/lib/openmeter/billing-profiles";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import {
  buildOwnerCustomerKey,
} from "../src/lib/openmeter/customer-key";
import { resolveOpenMeterBillingIdentity } from "../src/lib/openmeter/billing-identity";
import {
  ensureOpenMeterCustomer,
  findOpenMeterCustomerByKey,
} from "../src/lib/openmeter/customers";
import {
  getKonnectCustomerBillingProfileId,
  getStripeCustomerAppDataId,
} from "../src/lib/openmeter/stripe-customer-data";
import { getHostedOpenMeterUrl } from "../src/lib/openmeter/constants";
import { buildOpenMeterPlanKey } from "../src/lib/openmeter/plans-sync";
import { shouldUseKonnectRoutes } from "../src/lib/openmeter/route-mode";
import {
  findOpenMeterSubscriptionByPlanKey,
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
} from "../src/lib/openmeter/subscription-read";
import { getOrCreateStarterPlan } from "../src/lib/starter-default-plan";
import { sanitizeForLog } from "../src/lib/sanitize-for-log";

type Args = {
  apply: boolean;
  clientId?: string;
  ownersOnly: boolean;
  appsOnly: boolean;
  limit?: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, ownersOnly: false, appsOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--owners-only") {
      args.ownersOnly = true;
      continue;
    }
    if (token === "--apps-only") {
      args.appsOnly = true;
      continue;
    }
    if (token === "--client-id") {
      args.clientId = argv[++i]?.trim();
      continue;
    }
    if (token === "--limit") {
      args.limit = Number(argv[++i]);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

async function resolveSandboxProfileIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const fromEnv = process.env.OPENMETER_FREE_BILLING_PROFILE_ID?.trim();
  if (fromEnv) {
    ids.add(fromEnv);
  }
  const client = getHostedAdminClient();
  let page = 1;
  const pageSize = 100;
  for (;;) {
    const listed = await client.billing.profiles.list({ page, pageSize });
    const items = listed?.items ?? [];
    for (const profile of items) {
      if (
        profile.id &&
        (profile.name === "pymthouse-free" ||
          profile.name?.toLowerCase().includes("sandbox"))
      ) {
        ids.add(profile.id);
      }
    }
    if (!listed || items.length < pageSize) {
      break;
    }
    page += 1;
  }
  return ids;
}

async function customerNeedsMigration(input: {
  customerId: string;
  sandboxProfileIds: Set<string>;
  expectedProfileId?: string | null;
}): Promise<{
  needs: boolean;
  reason: string;
  profileId: string | null;
  stripeCus: string | null;
}> {
  const stripeCus = await getStripeCustomerAppDataId({
    client: getHostedAdminClient(),
    customerId: input.customerId,
  });
  const useKonnect = shouldUseKonnectRoutes(
    getHostedOpenMeterUrl(),
    process.env.OPENMETER_API_KEY,
  );
  let profileId: string | null = null;
  if (useKonnect) {
    profileId = await getKonnectCustomerBillingProfileId(input.customerId);
  }

  if (!stripeCus) {
    return {
      needs: true,
      reason: "missing_stripe_app_data",
      profileId,
      stripeCus: null,
    };
  }
  if (profileId && input.sandboxProfileIds.has(profileId)) {
    return {
      needs: true,
      reason: "sandbox_billing_profile",
      profileId,
      stripeCus,
    };
  }
  const expected = input.expectedProfileId?.trim();
  if (expected && profileId !== expected) {
    return {
      needs: true,
      reason: "wrong_billing_profile",
      profileId,
      stripeCus,
    };
  }
  return { needs: false, reason: "ok", profileId, stripeCus };
}

/**
 * Starter end users belong on the free billing profile: Konnect rejects a
 * Starter subscription for a customer pinned to a Stripe profile without a
 * default payment method. Only end users holding a paid subscription get moved.
 */
async function hasPaidSubscription(input: {
  clientId: string;
  customerId: string;
}): Promise<boolean> {
  const client = getHostedAdminClient();
  const starter = await getOrCreateStarterPlan(input.clientId);
  // Listed subscriptions carry only plan_id, so match Starter through the
  // plan-key resolver and compare by subscription id.
  const starterSub = await findOpenMeterSubscriptionByPlanKey(
    client,
    input.customerId,
    buildOpenMeterPlanKey(input.clientId, starter.id),
    { openmeterPlanId: starter.openmeterPlanId },
  );
  const subscriptions = await listOpenMeterSubscriptionsForCustomer(
    client,
    input.customerId,
  );
  return subscriptions.some(
    (sub) => isOpenMeterSubscriptionActive(sub.status) && sub.id !== starterSub?.id,
  );
}

async function migrateAppUser(input: {
  clientId: string;
  externalUserId: string;
  apply: boolean;
  sandboxProfileIds: Set<string>;
}): Promise<"migrated" | "skipped" | "error"> {
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  if (identity.isOwner) {
    // Owners are handled in the owner pass.
    return "skipped";
  }

  const key = identity.customerKey;
  const client = getHostedAdminClient();
  const found = await findOpenMeterCustomerByKey(client, key);
  let customerId = found?.id?.trim() || "";
  if (!customerId) {
    if (!input.apply) {
      console.log(`[dry-run] would ensure customer ${key}`);
      return "skipped";
    }
    const ensured = await ensureOpenMeterCustomer(client, key);
    customerId = ensured.id;
  }

  if (
    !(await hasPaidSubscription({
      clientId: identity.developerAppId,
      customerId,
    }))
  ) {
    console.log(
      `[skip] ${key} customer=${customerId} starter-only (stays on free billing profile)`,
    );
    return "skipped";
  }

  const ready = await ensureAppStripeBillingReady({
    clientId: identity.developerAppId,
  });
  const status = await customerNeedsMigration({
    customerId,
    sandboxProfileIds: input.sandboxProfileIds,
    expectedProfileId: ready.openmeterBillingProfileId,
  });
  if (!status.needs) {
    console.log(
      `[skip] ${key} customer=${customerId} stripe=${status.stripeCus} profile=${status.profileId ?? "n/a"}`,
    );
    return "skipped";
  }

  console.log(
    `[${input.apply ? "apply" : "dry-run"}] ${key} reason=${status.reason} customer=${customerId} oldProfile=${status.profileId ?? "n/a"} stripe=${status.stripeCus ?? "none"}`,
  );
  if (!input.apply) {
    return "migrated";
  }

  await prepareAppCustomerStripeBilling({
    client,
    clientId: identity.developerAppId,
    customerId,
    customerKey: key,
  });
  const after = await getStripeCustomerAppDataId({
    client,
    customerId,
  });
  if (!after) {
    throw new Error(
      `Migration did not persist Stripe app data for ${key} (${customerId})`,
    );
  }
  console.log(`[ok] ${key} stripe=${after}`);
  return "migrated";
}

async function migrateOwner(input: {
  ownerUserId: string;
  apply: boolean;
  sandboxProfileIds: Set<string>;
}): Promise<"migrated" | "skipped" | "error"> {
  const key = buildOwnerCustomerKey(input.ownerUserId);
  const client = getHostedAdminClient();
  const customer = await findOpenMeterCustomerByKey(client, key);
  if (!customer?.id) {
    console.log(`[skip] owner ${key} — no OpenMeter customer`);
    return "skipped";
  }

  const ownersProfileId = await ensureOwnersBillingProfile(client);
  const status = await customerNeedsMigration({
    customerId: customer.id,
    sandboxProfileIds: input.sandboxProfileIds,
    expectedProfileId: ownersProfileId,
  });
  if (!status.needs) {
    console.log(
      `[skip] owner ${sanitizeForLog(key)} customer=${sanitizeForLog(customer.id)} stripe=${sanitizeForLog(status.stripeCus)} profile=${sanitizeForLog(status.profileId ?? "n/a")}`,
    );
    return "skipped";
  }

  console.log(
    `[${input.apply ? "apply" : "dry-run"}] owner ${sanitizeForLog(key)} reason=${sanitizeForLog(status.reason)} customer=${sanitizeForLog(customer.id)} oldProfile=${sanitizeForLog(status.profileId ?? "n/a")}`,
  );
  if (!input.apply) {
    return "migrated";
  }

  await prepareOwnerCustomerStripeBilling({
    client,
    customerId: customer.id,
    customerKey: key,
  });
  const after = await getStripeCustomerAppDataId({
    client,
    customerId: customer.id,
  });
  if (!after) {
    throw new Error(
      `Migration did not persist Stripe app data for owner ${key} (${customer.id})`,
    );
  }
  console.log(`[ok] owner ${sanitizeForLog(key)} stripe=${sanitizeForLog(after)}`);
  return "migrated";
}

async function main() {
  if (!isHostedAdminClientAvailable()) {
    console.error("[migrate-sandbox-to-stripe] OPENMETER_URL is not configured.");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const sandboxProfileIds = await resolveSandboxProfileIds();
  console.log(
    `Sandbox profile ids: ${
      sandboxProfileIds.size ? [...sandboxProfileIds].join(", ") : "(none found)"
    }`,
  );
  console.log(args.apply ? "Mode: APPLY" : "Mode: dry-run (pass --apply to write)");

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;

  if (!args.ownersOnly) {
    const userQuery = db
      .select({
        clientId: appUsers.clientId,
        externalUserId: appUsers.externalUserId,
      })
      .from(appUsers);

    const rows = args.clientId
      ? await userQuery.where(eq(appUsers.clientId, args.clientId))
      : await userQuery;

    for (const row of rows) {
      if (args.limit !== undefined && processed >= args.limit) {
        break;
      }
      processed += 1;
      try {
        const result = await migrateAppUser({
          clientId: row.clientId,
          externalUserId: row.externalUserId,
          apply: args.apply,
          sandboxProfileIds,
        });
        if (result === "migrated") migrated += 1;
        else skipped += 1;
      } catch (err) {
        errors += 1;
        console.error(
          `[error] ${row.clientId}:${row.externalUserId}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  if (!args.appsOnly && !args.clientId) {
    const ownerRows = await db.select({ id: users.id }).from(users);
    for (const owner of ownerRows) {
      if (args.limit !== undefined && processed >= args.limit) {
        break;
      }
      processed += 1;
      try {
        const result = await migrateOwner({
          ownerUserId: owner.id,
          apply: args.apply,
          sandboxProfileIds,
        });
        if (result === "migrated") migrated += 1;
        else skipped += 1;
      } catch (err) {
        errors += 1;
        console.error(
          `[error] owner ${owner.id}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } else if (!args.appsOnly && args.clientId) {
    // App-scoped run: also migrate owners of that app
    const app = await db
      .select({ ownerId: developerApps.ownerId })
      .from(developerApps)
      .where(eq(developerApps.id, args.clientId))
      .limit(1);
    const ownerId = app[0]?.ownerId;
    if (ownerId) {
      try {
        const result = await migrateOwner({
          ownerUserId: ownerId,
          apply: args.apply,
          sandboxProfileIds,
        });
        if (result === "migrated") migrated += 1;
        else skipped += 1;
      } catch (err) {
        errors += 1;
        console.error({
          message: "[error] owner migrate failed",
          ownerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  console.log(
    `Done. migrated=${migrated} skipped=${skipped} errors=${errors} (dry-run counts intended migrations as migrated)`,
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
