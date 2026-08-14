/**
 * Migrate end-user OpenMeter customers from legacy compound keys
 * (`app_…:externalUserId`) onto stable `eu_{end_users.id}` keys.
 *
 * - Ensures the eu_ customer exists with subjectKeys = [eu_…]
 * - Records the mapping in Neon `billing_customers`
 * - Under `--full`, applies mode-aware balance cutover:
 *     merchant      → transfer prepaid onto eu_, cancel legacy, provision Starter
 *     owner_rollup  → transfer prepaid onto the owner wallet, cancel legacy
 *                     (eu_ is actor-only; do not strand credits on eu_)
 * - Without `--full`, granular flags still work for merchant apps
 *
 * Production cutover (all apps):
 *   npm run openmeter:migrate-end-user-customers -- --full --dry-run
 *   npm run openmeter:migrate-end-user-customers -- --full
 *
 * Single app:
 *   npm run openmeter:migrate-end-user-customers -- --client-id app_… --full
 *   npm run openmeter:migrate-end-user-customers -- --client-id app_… --transfer-balances --cancel-legacy --provision-merchant
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
  buildOwnerCustomerKey,
} from "../src/lib/openmeter/customer-key";
import {
  ensureOpenMeterCustomer,
  ensureOwnerCustomer,
  recordBillingCustomer,
} from "../src/lib/openmeter/customers";
import {
  auditBillingConsistency,
  type BillingConsistencyFinding,
} from "../src/lib/openmeter/billing-consistency";
import {
  resolveEndUserMigratePolicy,
  type EndUserMigratePolicy,
  type EndUserTransferTarget,
} from "../src/lib/openmeter/end-user-migrate-policy";
import { shouldUseKonnectRoutes } from "../src/lib/openmeter/route-mode";
import { ensureStarterSubscriptionForAppUser } from "../src/lib/openmeter/starter-subscription";
import { requireKonnectConfig } from "./lib/openmeter-konnect-migrate";
import {
  cancelLegacySubscriptions,
  findCustomerIdByKey,
  releaseLegacySubjectKeys,
  transferLegacyWalletBalance,
} from "./lib/openmeter-legacy-wallet-migrate";

type Args = {
  clientId?: string;
  full: boolean;
  transferBalances: boolean;
  cancelLegacy: boolean;
  provisionMerchant: boolean;
  dryRun: boolean;
};

type AppRow = {
  developerAppId: string;
  publicClientId: string;
  billingMode: "owner_rollup" | "merchant";
  ownerId: string | null;
};

type EndUserRow = {
  endUserId: string;
  externalUserId: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    full: false,
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
    if (token === "--full") {
      args.full = true;
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
  if (args.full) {
    return args;
  }
  if (args.transferBalances && !args.cancelLegacy) {
    throw new Error(
      "--transfer-balances requires --cancel-legacy so credits are not left " +
        "live on both the legacy compound wallet and the target customer.\n" +
        usage(),
    );
  }
  return args;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run openmeter:migrate-end-user-customers -- --full [--dry-run]",
    "  npm run openmeter:migrate-end-user-customers -- --client-id <app_…> --full",
    "  npm run openmeter:migrate-end-user-customers -- --client-id <app_…> [flags]",
    "",
    "  (no --client-id)         Migrate every app with a public client id",
    "  --client-id <id>         Public client id or developer_apps.id",
    "  --full                   Mode-aware production cutover (recommended):",
    "                           merchant → transfer→eu_, cancel legacy, Starter",
    "                           owner_rollup → transfer→owner wallet, cancel legacy",
    "  --transfer-balances      Merchant-only granular path: grant from legacy→eu_",
    "                           (requires --cancel-legacy; rejected for owner_rollup)",
    "  --cancel-legacy          Cancel legacy compound subs and release subjectKeys",
    "  --provision-merchant     Create Starter on eu_ when billingMode=merchant",
    "                           (implied by --full for merchant apps)",
    "  --dry-run                Print actions without OpenMeter mutations",
    "  --help",
  ].join("\n");
}

function toAppRow(row: {
  developerAppId: string;
  publicClientId: string | null;
  billingMode: string | null;
  ownerId: string | null;
}): AppRow | null {
  const publicClientId = row.publicClientId?.trim();
  if (!publicClientId) return null;
  return {
    developerAppId: row.developerAppId,
    publicClientId,
    billingMode: row.billingMode === "merchant" ? "merchant" : "owner_rollup",
    ownerId: row.ownerId?.trim() || null,
  };
}

async function resolveApp(clientIdOrAppId: string): Promise<AppRow> {
  const id = clientIdOrAppId.trim();
  const byPublic = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
      billingMode: appBillingConfig.billingMode,
      ownerId: developerApps.ownerId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(appBillingConfig, eq(appBillingConfig.clientId, developerApps.id))
    .where(eq(oidcClients.clientId, id))
    .limit(1);
  if (byPublic[0]) {
    const app = toAppRow(byPublic[0]);
    if (app) return app;
  }

  const byApp = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
      billingMode: appBillingConfig.billingMode,
      ownerId: developerApps.ownerId,
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
  const app = toAppRow({
    ...row,
    publicClientId: row.publicClientId?.trim() || row.developerAppId,
  });
  if (!app) {
    throw new Error(`App has no public client id: ${id}`);
  }
  return app;
}

async function listAllApps(): Promise<AppRow[]> {
  const rows = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
      billingMode: appBillingConfig.billingMode,
      ownerId: developerApps.ownerId,
    })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .leftJoin(appBillingConfig, eq(appBillingConfig.clientId, developerApps.id));

  const apps: AppRow[] = [];
  for (const row of rows) {
    const app = toAppRow(row);
    if (app) apps.push(app);
  }
  return apps;
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

async function ensureEndUserCustomer(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  app: AppRow;
  endUser: EndUserRow;
  euKey: string;
  dryRun: boolean;
}): Promise<string | null> {
  if (input.dryRun) {
    console.log(`  [dry-run] would ensure customer ${input.euKey}`);
    return null;
  }
  const ensured = await ensureOpenMeterCustomer(
    input.client,
    input.euKey,
    `End user ${input.endUser.externalUserId}`,
  );
  await recordBillingCustomer({
    customerKey: input.euKey,
    kind: "end_user",
    endUserId: input.endUser.endUserId,
    clientId: input.app.developerAppId,
    openmeterCustomerId: ensured.id,
  });
  console.log(`  [ok] ensured ${input.euKey} id=${ensured.id}`);
  return ensured.id;
}

async function resolveTransferTarget(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  app: AppRow;
  euKey: string;
  euCustomerId: string | null;
  transferTarget: EndUserTransferTarget;
  dryRun: boolean;
}): Promise<{ targetKey: string; targetCustomerId: string | null } | null> {
  if (input.transferTarget === "none") {
    return null;
  }
  if (input.transferTarget === "eu") {
    return {
      targetKey: input.euKey,
      targetCustomerId: input.euCustomerId,
    };
  }

  if (!input.app.ownerId) {
    throw new Error(
      `owner_rollup app ${input.app.publicClientId} has no ownerId; ` +
        "cannot transfer legacy end-user prepaid onto the owner wallet",
    );
  }
  const ownerKey = buildOwnerCustomerKey(input.app.ownerId);
  if (input.dryRun) {
    console.log(
      `  [dry-run] would transfer legacy prepaid onto owner wallet ${ownerKey}`,
    );
    return { targetKey: ownerKey, targetCustomerId: null };
  }
  const owner = await ensureOwnerCustomer(input.client, input.app.ownerId, [
    input.app.publicClientId,
  ]);
  await recordBillingCustomer({
    customerKey: ownerKey,
    kind: "platform_user",
    platformUserId: input.app.ownerId,
    clientId: input.app.developerAppId,
    openmeterCustomerId: owner.id,
  });
  console.log(`  [ok] owner wallet ${ownerKey} id=${owner.id}`);
  return { targetKey: ownerKey, targetCustomerId: owner.id };
}

async function migrateLegacyWallet(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  legacyKey: string;
  transferTarget: EndUserTransferTarget;
  targetKey: string | null;
  targetCustomerId: string | null;
  cancelLegacy: boolean;
  dryRun: boolean;
  apiKey: string | undefined;
  baseUrl: string;
}): Promise<void> {
  const legacyId = await findCustomerIdByKey(input.client, input.legacyKey);
  if (!legacyId) {
    console.log(`  [skip] no legacy wallet ${input.legacyKey}`);
    return;
  }

  if (input.transferTarget !== "none" && input.targetKey) {
    const targetCustomerId = input.targetCustomerId ?? "dry-run";
    await transferLegacyWalletBalance({
      legacyCustomerId: legacyId,
      legacyKey: input.legacyKey,
      targetCustomerId,
      targetKey: input.targetKey,
      featureKey: DEFAULT_TRIAL_FEATURE_KEY,
      grantName:
        input.transferTarget === "owner"
          ? "Migrated end-user prepaid → owner wallet"
          : "Migrated end-user prepaid balance",
      idempotencyKey: `migrate-eu:${input.transferTarget}:${targetCustomerId}:${legacyId}`,
      apiKey: input.apiKey,
      dryRun: input.dryRun || !input.targetCustomerId,
    });
  }

  if (!input.cancelLegacy) {
    return;
  }
  await cancelLegacySubscriptions({
    client: input.client,
    customerId: legacyId,
    customerKey: input.legacyKey,
    dryRun: input.dryRun,
  });
  if (!input.apiKey) {
    throw new Error(
      "OPENMETER_API_KEY is required to release legacy subjects",
    );
  }
  await releaseLegacySubjectKeys({
    customerId: legacyId,
    customerKey: input.legacyKey,
    dryRun: input.dryRun,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });
}

async function provisionMerchantStarter(input: {
  app: AppRow;
  endUser: EndUserRow;
  dryRun: boolean;
}): Promise<void> {
  if (input.app.billingMode !== "merchant") {
    return;
  }
  if (input.dryRun) {
    console.log(
      `  [dry-run] would provision merchant Starter for ${input.endUser.externalUserId}`,
    );
    return;
  }
  const sub = await ensureStarterSubscriptionForAppUser({
    clientId: input.app.publicClientId,
    externalUserId: input.endUser.externalUserId,
  });
  console.log(
    `  [ok] merchant Starter openmeterSubscriptionId=${sub.openmeterSubscriptionId} created=${sub.created}`,
  );
}

async function migrateEndUser(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  app: AppRow;
  endUser: EndUserRow;
  policy: EndUserMigratePolicy;
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
    `\n[end-user] ext=${input.endUser.externalUserId} eu=${euKey} legacy=${legacyKey} ` +
      `transfer=${input.policy.transferTarget}`,
  );

  const euCustomerId = await ensureEndUserCustomer({
    client: input.client,
    app: input.app,
    endUser: input.endUser,
    euKey,
    dryRun: input.dryRun,
  });

  const transfer = await resolveTransferTarget({
    client: input.client,
    app: input.app,
    euKey,
    euCustomerId,
    transferTarget: input.policy.transferTarget,
    dryRun: input.dryRun,
  });

  await migrateLegacyWallet({
    client: input.client,
    legacyKey,
    transferTarget: input.policy.transferTarget,
    targetKey: transfer?.targetKey ?? null,
    targetCustomerId: transfer?.targetCustomerId ?? null,
    cancelLegacy: input.policy.cancelLegacy,
    dryRun: input.dryRun,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  });

  if (input.policy.provisionMerchantStarter) {
    await provisionMerchantStarter({
      app: input.app,
      endUser: input.endUser,
      dryRun: input.dryRun,
    });
  }
}

async function runAttributionExitGate(publicClientId: string): Promise<void> {
  console.log(`\nRunning attribution consistency exit gate for ${publicClientId}…`);
  const findings = await auditBillingConsistency({
    clientId: publicClientId,
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
      `Attribution exit gate failed for ${publicClientId}: ` +
        `${attributionErrors.length} error(s). ` +
        "No subject may carry usage that no customer is attributed. " +
        "Fix with ensure/release, then re-run.",
    );
  }
  console.log(
    `Attribution exit gate passed for ${publicClientId} ` +
      "(no usage_on_unattributed_subject / customer_has_no_usage_attribution errors).",
  );
}

async function migrateApp(input: {
  app: AppRow;
  args: Args;
  client: ReturnType<typeof getHostedAdminClient>;
  apiKey: string | undefined;
  baseUrl: string;
}): Promise<void> {
  const policy = resolveEndUserMigratePolicy({
    billingMode: input.app.billingMode,
    full: input.args.full,
    transferBalances: input.args.transferBalances,
    cancelLegacy: input.args.cancelLegacy,
    provisionMerchant: input.args.provisionMerchant,
  });
  const endUsersForApp = await listEndUsersForApp(input.app, {
    dryRun: input.args.dryRun,
  });

  console.log(
    `\n=== ${input.app.publicClientId} mode=${input.app.billingMode} ` +
      `users=${endUsersForApp.length} transfer=${policy.transferTarget} ` +
      `cancelLegacy=${policy.cancelLegacy} ` +
      `provisionMerchant=${policy.provisionMerchantStarter} ` +
      `dryRun=${input.args.dryRun} ===`,
  );

  for (const endUser of endUsersForApp) {
    await migrateEndUser({
      client: input.client,
      app: input.app,
      endUser,
      policy,
      dryRun: input.args.dryRun,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
    });
  }

  if (input.args.dryRun) {
    console.log(
      `\n[dry-run] skipped attribution exit gate for ${input.app.publicClientId}.`,
    );
    return;
  }
  await runAttributionExitGate(input.app.publicClientId);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured (OPENMETER_URL / API key)");
  }

  const apps = args.clientId
    ? [await resolveApp(args.clientId)]
    : await listAllApps();
  if (apps.length === 0) {
    console.log("No apps found.");
    return;
  }

  if (!args.full && !args.clientId) {
    console.log(
      "Migrating all apps in ensure-only mode (no balance transfer / cancel). " +
        "Pass --full for production cutover, or --client-id for one app.",
    );
  }

  const client = getHostedAdminClient();
  let apiKey = process.env.OPENMETER_API_KEY?.trim();
  let baseUrl = getHostedOpenMeterUrl();
  const needsKonnect =
    args.full || args.cancelLegacy || args.transferBalances;
  if (needsKonnect && shouldUseKonnectRoutes(baseUrl, apiKey)) {
    const konnect = requireKonnectConfig();
    baseUrl = konnect.baseUrl;
    apiKey = konnect.apiKey;
  }

  console.log(
    `End-user migrate apps=${apps.length} full=${args.full} dryRun=${args.dryRun}`,
  );

  for (const app of apps) {
    await migrateApp({
      app,
      args,
      client,
      apiKey,
      baseUrl,
    });
  }

  if (args.dryRun) {
    console.log(
      "\n[dry-run] done. Re-run without --dry-run, then " +
        "`npm run openmeter:audit-billing`.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
