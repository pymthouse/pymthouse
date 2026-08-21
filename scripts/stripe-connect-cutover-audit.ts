/**
 * Audit apps for Stripe Connect hard-cutover readiness / drift.
 *
 * Usage:
 *   npm run stripe:connect-cutover-audit
 *   npm run stripe:connect-cutover-audit -- --client-id app_x
 */
import "./load-env-first";
import { count, eq } from "drizzle-orm";
import { closeDb, db } from "../src/db/index";
import {
  appBillingConfig,
  appUserStripeCustomers,
  developerApps,
  plans,
} from "../src/db/schema";
import { classifyConnectCutoverFindings } from "../src/lib/stripe/connect-cutover";
import { takeArgValue } from "./lib/openmeter-konnect-migrate";

type Args = { clientId?: string };

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--client-id") {
      args.clientId = takeArgValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apps = args.clientId?.trim()
    ? await db
        .select({ id: developerApps.id })
        .from(developerApps)
        .where(eq(developerApps.id, args.clientId.trim()))
    : await db.select({ id: developerApps.id }).from(developerApps);

  const findings: import("../src/lib/stripe/connect-cutover").ConnectCutoverFinding[] = [];
  for (const app of apps) {
    const configRows = await db
      .select()
      .from(appBillingConfig)
      .where(eq(appBillingConfig.clientId, app.id))
      .limit(1);
    const config = configRows[0];
    const appPlans = await db
      .select()
      .from(plans)
      .where(eq(plans.clientId, app.id));
    const hasPaidActivePlan = appPlans.some(
      (p) =>
        p.status === "active" &&
        p.type === "subscription" &&
        Number.parseFloat(p.priceAmount || "0") > 0,
    );

    const [{ value: mappedCustomerCount }] = await db
      .select({ value: count() })
      .from(appUserStripeCustomers)
      .where(eq(appUserStripeCustomers.clientId, app.id));

    findings.push(
      ...classifyConnectCutoverFindings({
        clientId: app.id,
        hasPaidActivePlan,
        stripeConnectedAccountId: config?.stripeConnectedAccountId ?? null,
        stripeChargesEnabled: config?.stripeChargesEnabled ?? false,
        connectPaymentsOnly: config?.connectPaymentsOnly ?? false,
        mappedCustomerCount: Number(mappedCustomerCount),
      }),
    );
  }

  console.log(JSON.stringify({ findings, count: findings.length }, null, 2));
  if (findings.some((f) => f.severity === "error")) {
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
