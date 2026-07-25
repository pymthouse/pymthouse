/**
 * Hard-cutover end-user payments onto merchant Stripe Connected Accounts.
 *
 * Usage:
 *   npm run stripe:connect-cutover -- --client-id app_x
 *   npm run stripe:connect-cutover -- --client-id app_x --apply
 *   npm run stripe:connect-cutover -- --all --apply
 */
import "./load-env-first";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/db/index";
import { appBillingConfig, developerApps } from "../src/db/schema";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import { upsertAppBillingConfig } from "../src/lib/openmeter/billing-profiles";
import { buildOpenMeterCustomerKey, parseOpenMeterCustomerKey } from "../src/lib/openmeter/customer-key";
import {
  ensureMerchantOwnedStripeCustomer,
  syncMerchantConnectStatus,
} from "../src/lib/stripe/merchant-connect";
import { refreshConnectedAccountStatus } from "../src/lib/stripe/connect-accounts";
import { takeArgValue } from "./lib/openmeter-konnect-migrate";

type Args = {
  apply: boolean;
  clientId?: string;
  all: boolean;
  includeOwners: boolean;
  limit?: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, all: false, includeOwners: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--all") {
      args.all = true;
      continue;
    }
    if (token === "--include-owners") {
      args.includeOwners = true;
      continue;
    }
    if (token === "--client-id") {
      args.clientId = takeArgValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--limit") {
      args.limit = Number(takeArgValue(argv, i, token));
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.all && !args.clientId?.trim()) {
    throw new Error("Provide --client-id app_… or --all");
  }
  return args;
}

async function listClientIds(args: Args): Promise<string[]> {
  if (args.clientId?.trim()) {
    return [args.clientId.trim()];
  }
  const rows = await db
    .select({ id: developerApps.id })
    .from(developerApps);
  return rows.map((r) => r.id);
}

async function listAppCustomerKeys(
  clientId: string,
  includeOwners: boolean,
): Promise<Array<{ key: string; id: string }>> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OPENMETER_URL / OPENMETER_API_KEY not configured");
  }
  const client = getHostedAdminClient();
  const out: Array<{ key: string; id: string }> = [];
  let page = 1;
  const pageSize = 100;
  const prefix = `${clientId}:`;
  for (;;) {
    const listed = await client.customers.list({ page, pageSize });
    const items = listed?.items ?? [];
    for (const item of items) {
      const key = item.key?.trim() || "";
      const id = item.id?.trim() || "";
      if (!key || !id) continue;
      if (key.startsWith(prefix)) {
        out.push({ key, id });
        continue;
      }
      if (includeOwners && !key.includes(":")) {
        out.push({ key, id });
      }
    }
    if (items.length < pageSize) break;
    page += 1;
  }
  return out;
}

async function cutoverApp(input: {
  clientId: string;
  apply: boolean;
  includeOwners: boolean;
  limit?: number;
}): Promise<{ migrated: number; skipped: number; needsCheckout: number; errors: number }> {
  const configRows = await db
    .select()
    .from(appBillingConfig)
    .where(eq(appBillingConfig.clientId, input.clientId))
    .limit(1);
  const config = configRows[0];
  const accountId = config?.stripeConnectedAccountId?.trim();
  if (!accountId) {
    console.error(`[${input.clientId}] skip: no stripeConnectedAccountId`);
    return { migrated: 0, skipped: 1, needsCheckout: 0, errors: 1 };
  }

  await syncMerchantConnectStatus(input.clientId);
  const status = await refreshConnectedAccountStatus(accountId);
  if (!status.chargesEnabled) {
    console.error(
      `[${input.clientId}] skip: charges_enabled=false (complete Account Link / OAuth onboarding)`,
    );
    return { migrated: 0, skipped: 1, needsCheckout: 0, errors: 1 };
  }

  let customers = await listAppCustomerKeys(
    input.clientId,
    input.includeOwners,
  );
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
    customers = customers.slice(0, Math.max(0, input.limit));
  }

  console.log(
    JSON.stringify(
      {
        clientId: input.clientId,
        accountId,
        mode: input.apply ? "apply" : "dry-run",
        candidates: customers.length,
      },
      null,
      2,
    ),
  );

  let migrated = 0;
  let skipped = 0;
  let needsCheckout = 0;
  let errors = 0;

  for (const customer of customers) {
    const parsed = parseOpenMeterCustomerKey(customer.key);
    const externalUserId =
      parsed?.externalUserId ||
      (customer.key.includes(":")
        ? customer.key.slice(customer.key.indexOf(":") + 1)
        : customer.key);

    if (!input.apply) {
      console.log(
        `dry-run would map key=${customer.key} -> merchant cus on ${accountId}`,
      );
      migrated += 1;
      needsCheckout += 1;
      continue;
    }

    try {
      await ensureMerchantOwnedStripeCustomer({
        clientId: input.clientId,
        externalUserId,
        accountId,
        openmeterCustomerId: customer.id,
        openmeterCustomerKey: customer.key || buildOpenMeterCustomerKey(input.clientId, externalUserId),
      });
      console.log(`migrated key=${customer.key} needs_checkout=true`);
      migrated += 1;
      needsCheckout += 1;
    } catch (err) {
      errors += 1;
      console.error(
        `fail key=${customer.key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (input.apply && errors === 0) {
    await upsertAppBillingConfig(input.clientId, {
      connectPaymentsOnly: true,
    });
    console.log(`[${input.clientId}] connectPaymentsOnly=true`);
  } else if (!input.apply) {
    console.log(`[${input.clientId}] dry-run would set connectPaymentsOnly=true`);
  }

  return { migrated, skipped, needsCheckout, errors };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const clientIds = await listClientIds(args);
  let totals = { migrated: 0, skipped: 0, needsCheckout: 0, errors: 0 };
  for (const clientId of clientIds) {
    const result = await cutoverApp({
      clientId,
      apply: args.apply,
      includeOwners: args.includeOwners,
      limit: args.limit,
    });
    totals = {
      migrated: totals.migrated + result.migrated,
      skipped: totals.skipped + result.skipped,
      needsCheckout: totals.needsCheckout + result.needsCheckout,
      errors: totals.errors + result.errors,
    };
  }
  console.log(JSON.stringify({ ...totals, apply: args.apply }, null, 2));
  if (totals.errors > 0) {
    process.exitCode = 1;
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
