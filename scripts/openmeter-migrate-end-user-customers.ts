/**
 * Migrate end-user OpenMeter customers from legacy compound keys
 * (`app_…:externalUserId`) onto stable `eu_{end_users.id}` keys.
 *
 * - Ensures the eu_ customer exists with subjectKeys = [eu_…]
 * - Records the mapping in Neon `billing_customers`
 * - Optionally transfers prepaid balances from the legacy compound wallet
 * - Optionally cancels active subscriptions on the legacy customer
 * - Optionally releases legacy subject keys
 * - Optionally provisions Starter on the eu_ customer for merchant apps
 *
 * Usage:
 *   npx tsx scripts/openmeter-migrate-end-user-customers.ts --client-id app_…
 *   npx tsx scripts/openmeter-migrate-end-user-customers.ts --client-id app_… --transfer-balances --cancel-legacy
 *   npx tsx scripts/openmeter-migrate-end-user-customers.ts --client-id app_… --provision-merchant --dry-run
 */
import "./load-env-first";
import { and, eq } from "drizzle-orm";

import { closeDb, db } from "../src/db/index";
import {
  appBillingConfig,
  appUsers,
  developerApps,
  endUsers,
  oidcClients,
} from "../src/db/schema";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import {
  DEFAULT_TRIAL_FEATURE_KEY,
  getHostedOpenMeterUrl,
} from "../src/lib/openmeter/constants";
import {
  buildEndUserCustomerKey,
  buildOpenMeterCustomerKey,
} from "../src/lib/openmeter/customer-key";
import {
  ensureOpenMeterCustomer,
  recordBillingCustomer,
} from "../src/lib/openmeter/customers";
import {
  auditBillingConsistency,
  type BillingConsistencyFinding,
} from "../src/lib/openmeter/billing-consistency";
import {
  createKonnectCreditGrant,
  getKonnectCreditBalance,
} from "../src/lib/openmeter/konnect-credits";
import { shouldUseKonnectRoutes } from "../src/lib/openmeter/route-mode";
import { ensureStarterSubscriptionForAppUser } from "../src/lib/openmeter/starter-subscription";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
} from "../src/lib/openmeter/subscription-read";
import {
  readKonnectSubjectKeys,
  replaceKonnectCustomerSubjectKeys,
  requireKonnectConfig,
} from "./lib/openmeter-konnect-migrate";

type Args = {
  clientId?: string;
  transferBalances: boolean;
  cancelLegacy: boolean;
  provisionMerchant: boolean;
  dryRun: boolean;
};

type AppRow = {
  developerAppId: string;
  publicClientId: string;
  billingMode: "owner_rollup" | "merchant";
};

type EndUserRow = {
  endUserId: string;
  externalUserId: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    transferBalances: false,
    cancelLegacy: false,
    provisionMerchant: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--client-id") {
      args.clientId = argv[++i]?.trim();
      continue;
    }
    if (token === "--transfer-balances") {
      args.transferBalances = true;
      continue;
    }
    if (token === "--cancel-legacy") {
      args.cancelLegacy = true;
      continue;
    }
    if (token === "--provision-merchant") {
      args.provisionMerchant = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}\n${usage()}`);
  }
  return args;
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/openmeter-migrate-end-user-customers.ts --client-id <app_…>",
    "  --client-id <id>         Public client id or developer_apps.id (required)",
    "  --transfer-balances      Grant remaining credits from legacy compound wallets",
    "  --cancel-legacy          Cancel active subscriptions on legacy customers",
    "  --provision-merchant     Create Starter on eu_ customers when billingMode=merchant",
    "  --dry-run                Print actions without OpenMeter mutations",
    "  --help",
  ].join("\n");
}

async function resolveApp(clientIdOrAppId: string): Promise<AppRow> {
  const id = clientIdOrAppId.trim();
  const byPublic = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
      billingMode: appBillingConfig.billingMode,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(appBillingConfig, eq(appBillingConfig.clientId, developerApps.id))
    .where(eq(oidcClients.clientId, id))
    .limit(1);
  if (byPublic[0]?.publicClientId) {
    return {
      developerAppId: byPublic[0].developerAppId,
      publicClientId: byPublic[0].publicClientId,
      billingMode:
        byPublic[0].billingMode === "merchant" ? "merchant" : "owner_rollup",
    };
  }

  const byApp = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
      billingMode: appBillingConfig.billingMode,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(appBillingConfig, eq(appBillingConfig.clientId, developerApps.id))
    .where(eq(developerApps.id, id))
    .limit(1);
  const row = byApp[0];
  if (!row?.developerAppId) {
    throw new Error(`App not found: ${id}`);
  }
  return {
    developerAppId: row.developerAppId,
    publicClientId: row.publicClientId?.trim() || row.developerAppId,
    billingMode: row.billingMode === "merchant" ? "merchant" : "owner_rollup",
  };
}

async function listEndUsersForApp(
  app: AppRow,
  options: { dryRun: boolean },
): Promise<EndUserRow[]> {
  const rows = await db
    .select({
      endUserId: endUsers.id,
      externalUserId: endUsers.externalUserId,
    })
    .from(endUsers)
    .where(eq(endUsers.appId, app.developerAppId));

  const byExternal = new Map<string, EndUserRow>();
  for (const row of rows) {
    const ext = row.externalUserId?.trim();
    if (!ext) continue;
    byExternal.set(ext, { endUserId: row.endUserId, externalUserId: ext });
  }

  // Backfill end_users from active app_users so every retail subject gets an eu_ key.
  const fromAppUsers = await db
    .select({
      externalUserId: appUsers.externalUserId,
    })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.clientId, app.developerAppId),
        eq(appUsers.status, "active"),
      ),
    );
  for (const row of fromAppUsers) {
    const ext = row.externalUserId?.trim();
    if (!ext || byExternal.has(ext)) continue;
    const existing = await db
      .select({ id: endUsers.id })
      .from(endUsers)
      .where(
        and(
          eq(endUsers.appId, app.developerAppId),
          eq(endUsers.externalUserId, ext),
        ),
      )
      .limit(1);
    if (existing[0]?.id) {
      byExternal.set(ext, {
        endUserId: existing[0].id,
        externalUserId: ext,
      });
      continue;
    }
    if (options.dryRun) {
      console.log(
        `  [dry-run] would create end_users row for externalUserId=${ext}`,
      );
      continue;
    }
    const id = crypto.randomUUID();
    await db.insert(endUsers).values({
      id,
      appId: app.developerAppId,
      externalUserId: ext,
    });
    byExternal.set(ext, { endUserId: id, externalUserId: ext });
  }
  return [...byExternal.values()];
}

function attributionGateFindings(
  findings: BillingConsistencyFinding[],
): BillingConsistencyFinding[] {
  return findings.filter(
    (f) =>
      f.severity === "error" &&
      (f.code === "usage_on_unattributed_subject" ||
        f.code === "customer_has_no_usage_attribution"),
  );
}

async function findCustomerIdByKey(
  client: ReturnType<typeof getHostedAdminClient>,
  customerKey: string,
): Promise<string | null> {
  const listed = await client.customers.list({
    key: customerKey,
    page: 1,
    pageSize: 50,
  });
  const match = (listed?.items ?? []).find((item) => item.key === customerKey);
  return match?.id ?? null;
}

async function transferBalance(input: {
  legacyCustomerId: string;
  legacyKey: string;
  targetCustomerId: string;
  targetKey: string;
  featureKey: string;
  apiKey: string | undefined;
  dryRun: boolean;
}): Promise<bigint> {
  const balance = await getKonnectCreditBalance({
    customerId: input.legacyCustomerId,
    apiKey: input.apiKey,
  });
  if (!balance || balance.balanceUsdMicros <= 0n) {
    console.log(`  [skip] empty legacy wallet ${input.legacyKey}`);
    return 0n;
  }
  console.log(
    `  [legacy] ${input.legacyKey} balance=${balance.balanceUsdMicros.toString()} micros`,
  );
  if (input.dryRun) {
    return balance.balanceUsdMicros;
  }
  await createKonnectCreditGrant({
    customerId: input.targetCustomerId,
    amountUsdMicros: balance.balanceUsdMicros,
    name: "Migrated end-user prepaid balance",
    description: `Transferred from legacy ${input.legacyKey}`,
    featureKey: input.featureKey,
    idempotencyKey: `migrate-eu:${input.targetCustomerId}:${input.legacyCustomerId}`,
    apiKey: input.apiKey,
  });
  console.log(
    `  [ok] granted ${balance.balanceUsdMicros.toString()} onto ${input.targetKey}`,
  );
  return balance.balanceUsdMicros;
}

async function cancelLegacySubscriptions(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  customerId: string;
  customerKey: string;
  dryRun: boolean;
}): Promise<number> {
  const listed = await listOpenMeterSubscriptionsForCustomer(
    input.client,
    input.customerId,
  );
  const active = listed.filter((s) => isOpenMeterSubscriptionActive(s.status));
  let cancels = 0;
  for (const sub of active) {
    if (input.dryRun) {
      console.log(
        `  [dry-run] would cancel ${sub.id} on legacy ${input.customerKey}`,
      );
    } else {
      await input.client.subscriptions.cancel(sub.id, { timing: "immediate" });
      console.log(`  [cancel] ${sub.id} on legacy ${input.customerKey}`);
    }
    cancels += 1;
  }
  return cancels;
}

async function releaseLegacySubjectKeys(input: {
  customerId: string;
  customerKey: string;
  dryRun: boolean;
  baseUrl: string;
  apiKey: string;
}): Promise<void> {
  if (input.dryRun) {
    console.log(
      `  [dry-run] would clear subjectKeys on legacy ${input.customerKey}`,
    );
    return;
  }
  const retiredKey = `deprecated:${input.customerKey}`;
  try {
    const updated = await replaceKonnectCustomerSubjectKeys({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      customerId: input.customerId,
      name: `Legacy ${input.customerKey}`,
      subjectKeys: [retiredKey],
    });
    const after = readKonnectSubjectKeys(updated);
    if (after.length !== 1 || after[0] !== retiredKey) {
      console.warn(
        `  [warn] release incomplete on ${input.customerKey}: got ${JSON.stringify(after)}`,
      );
      return;
    }
    console.log(
      `  [ok] released subjectKeys on ${input.customerKey} → ${retiredKey}`,
    );
  } catch (err) {
    console.warn(
      `  [warn] could not release subjectKeys on ${input.customerKey}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function migrateEndUser(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  app: AppRow;
  endUser: EndUserRow;
  transferBalances: boolean;
  cancelLegacy: boolean;
  provisionMerchant: boolean;
  dryRun: boolean;
  apiKey: string | undefined;
  baseUrl: string;
}): Promise<void> {
  const euKey = buildEndUserCustomerKey(input.endUser.endUserId);
  const legacyKey = buildOpenMeterCustomerKey(
    input.app.publicClientId,
    input.endUser.externalUserId,
  );
  console.log(
    `\n[end-user] ext=${input.endUser.externalUserId} eu=${euKey} legacy=${legacyKey}`,
  );

  let euCustomerId: string | null = null;
  if (input.dryRun) {
    console.log(`  [dry-run] would ensure customer ${euKey}`);
  } else {
    const ensured = await ensureOpenMeterCustomer(
      input.client,
      euKey,
      `End user ${input.endUser.externalUserId}`,
    );
    euCustomerId = ensured.id;
    await recordBillingCustomer({
      customerKey: euKey,
      kind: "end_user",
      endUserId: input.endUser.endUserId,
      clientId: input.app.developerAppId,
      openmeterCustomerId: ensured.id,
    });
    console.log(`  [ok] ensured ${euKey} id=${ensured.id}`);
  }

  const legacyId = await findCustomerIdByKey(input.client, legacyKey);
  if (!legacyId) {
    console.log(`  [skip] no legacy wallet ${legacyKey}`);
  } else {
    if (input.transferBalances && euCustomerId) {
      await transferBalance({
        legacyCustomerId: legacyId,
        legacyKey,
        targetCustomerId: euCustomerId,
        targetKey: euKey,
        featureKey: DEFAULT_TRIAL_FEATURE_KEY,
        apiKey: input.apiKey,
        dryRun: input.dryRun,
      });
    } else if (input.transferBalances && input.dryRun) {
      await transferBalance({
        legacyCustomerId: legacyId,
        legacyKey,
        targetCustomerId: "dry-run",
        targetKey: euKey,
        featureKey: DEFAULT_TRIAL_FEATURE_KEY,
        apiKey: input.apiKey,
        dryRun: true,
      });
    }

    if (input.cancelLegacy) {
      await cancelLegacySubscriptions({
        client: input.client,
        customerId: legacyId,
        customerKey: legacyKey,
        dryRun: input.dryRun,
      });
      if (!input.apiKey) {
        throw new Error(
          "OPENMETER_API_KEY is required to release legacy subjects",
        );
      }
      await releaseLegacySubjectKeys({
        customerId: legacyId,
        customerKey: legacyKey,
        dryRun: input.dryRun,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
      });
    }
  }

  if (
    input.provisionMerchant &&
    input.app.billingMode === "merchant" &&
    !input.dryRun
  ) {
    const sub = await ensureStarterSubscriptionForAppUser({
      clientId: input.app.publicClientId,
      externalUserId: input.endUser.externalUserId,
    });
    console.log(
      `  [ok] merchant Starter openmeterSubscriptionId=${sub.openmeterSubscriptionId} created=${sub.created}`,
    );
  } else if (input.provisionMerchant && input.dryRun) {
    console.log(
      `  [dry-run] would provision merchant Starter for ${input.endUser.externalUserId}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.clientId) {
    throw new Error(`--client-id is required\n${usage()}`);
  }
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured (OPENMETER_URL / API key)");
  }

  const app = await resolveApp(args.clientId);
  const endUsersForApp = await listEndUsersForApp(app, { dryRun: args.dryRun });
  const client = getHostedAdminClient();
  let apiKey = process.env.OPENMETER_API_KEY?.trim();
  let baseUrl = getHostedOpenMeterUrl();
  if (args.cancelLegacy || args.transferBalances) {
    if (shouldUseKonnectRoutes(baseUrl, apiKey)) {
      const konnect = requireKonnectConfig();
      baseUrl = konnect.baseUrl;
      apiKey = konnect.apiKey;
    }
  }

  console.log(
    `Migrating ${endUsersForApp.length} end-user(s) for ${app.publicClientId} ` +
      `mode=${app.billingMode} transfer=${args.transferBalances} ` +
      `cancelLegacy=${args.cancelLegacy} provisionMerchant=${args.provisionMerchant} ` +
      `dryRun=${args.dryRun}`,
  );

  for (const endUser of endUsersForApp) {
    await migrateEndUser({
      client,
      app,
      endUser,
      transferBalances: args.transferBalances,
      cancelLegacy: args.cancelLegacy,
      provisionMerchant: args.provisionMerchant,
      dryRun: args.dryRun,
      apiKey,
      baseUrl,
    });
  }

  if (args.dryRun) {
    console.log(
      "\n[dry-run] skipped attribution exit gate. Re-run without --dry-run, then confirm " +
        "classifyUsageAttributionConsistency (via openmeter:audit-billing) is clean.",
    );
    return;
  }

  console.log("\nRunning attribution consistency exit gate…");
  const findings = await auditBillingConsistency({
    clientId: app.publicClientId,
  });
  const attributionErrors = attributionGateFindings(findings);
  if (attributionErrors.length > 0) {
    for (const f of attributionErrors) {
      console.error(`[FAIL] ${f.code}: ${f.message}`);
      if (f.remediation) {
        console.error(`  fix: ${f.remediation}`);
      }
    }
    throw new Error(
      `Attribution exit gate failed: ${attributionErrors.length} error(s). ` +
        "No subject may carry usage that no customer is attributed. " +
        "Fix with ensure/release, then re-run.",
    );
  }
  console.log(
    "Attribution exit gate passed (no usage_on_unattributed_subject / " +
      "customer_has_no_usage_attribution errors).",
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
