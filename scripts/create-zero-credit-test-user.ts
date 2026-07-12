/**
 * Create a zero-included-usage test user and mint a composite API key for
 * balance-gate testing.
 *
 * Temporarily sets the app Starter plan includedUsdMicros to 0 (and syncs) so
 * provision does not attach monthly included usage, then restores the previous
 * value. Prefer a dedicated test app client id.
 */
import "./load-env-first";
import { eq } from "drizzle-orm";
import { closeDb, db } from "../src/db/index";
import { plans } from "../src/db/schema";
import { createAppUserApiKey } from "../src/lib/app-api-keys";
import { provisionAppUserBilling } from "../src/lib/billing/provision-app-user";
import { ensureOpenMeterCustomer } from "../src/lib/openmeter/customers";
import {
  getHostedTrialOpenMeterClient,
  getTrialFeatureKeyForApp,
} from "../src/lib/openmeter/client-factory";
import {
  getKonnectCreditBalance,
  listKonnectCreditGrants,
} from "../src/lib/openmeter/konnect-credits";
import { getTrialCreditBalance } from "../src/lib/openmeter/entitlements";
import { syncPlanToOpenMeter } from "../src/lib/openmeter/plans-sync";
import { getOrCreateStarterPlan } from "../src/lib/starter-default-plan";
import { getProviderAppByClientId } from "../src/lib/provider-apps";
import { resolveOrCreateAppUser } from "../src/lib/usage/record-signed-ticket";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1]?.trim();
}

async function main() {
  const clientId = argValue("--client-id");
  if (!clientId?.startsWith("app_")) {
    throw new Error("--client-id app_<24hex> is required");
  }

  const externalUserId =
    argValue("--external-user-id") || `balance-gate-zero-${Date.now()}`;

  const app = await getProviderAppByClientId(clientId);
  if (!app) {
    throw new Error(`developer app not found for ${clientId}`);
  }

  const starter = await getOrCreateStarterPlan(clientId);
  const previousIncluded = starter.includedUsdMicros;
  const now = new Date().toISOString();
  await db
    .update(plans)
    .set({ includedUsdMicros: "0", updatedAt: now })
    .where(eq(plans.id, starter.id));
  await syncPlanToOpenMeter(starter.id);

  try {
    await resolveOrCreateAppUser({ clientId, externalUserId });

    const om = getHostedTrialOpenMeterClient();
    if (!om) throw new Error("OpenMeter not configured");
    const customer = await ensureOpenMeterCustomer(
      om,
      `${clientId}:${externalUserId}`,
    );
    await getTrialFeatureKeyForApp(clientId);

    const provisioned = await provisionAppUserBilling({
      clientId,
      externalUserId,
    });

    const created = await createAppUserApiKey({
      developerAppId: app.id,
      appUserId: provisioned.appUserId,
      publicClientId: clientId,
      label: "balance-gate-zero-credit",
    });

    const grants = await listKonnectCreditGrants({ customerId: customer.id });
    const raw = await getKonnectCreditBalance({ customerId: customer.id });
    const balance = await getTrialCreditBalance({ clientId, externalUserId });

    console.log(
      JSON.stringify(
        {
          clientId,
          externalUserId,
          appUserId: provisioned.appUserId,
          customerId: customer.id,
          customerKey: `${clientId}:${externalUserId}`,
          starterIncludedUsdMicros: "0",
          previousStarterIncludedUsdMicros: previousIncluded,
          grants: grants.map((g) => ({
            id: g.id,
            key: g.key,
            amount: g.amount,
            status: g.status,
          })),
          raw: raw
            ? {
                balanceUsdMicros: raw.balanceUsdMicros.toString(),
                lifetimeGrantedUsdMicros: raw.lifetimeGrantedUsdMicros.toString(),
                consumedUsdMicros: raw.consumedUsdMicros.toString(),
              }
            : null,
          balance,
          apiKey: created.apiKey,
          keyId: created.id,
        },
        null,
        2,
      ),
    );

    if (balance?.hasAccess || (raw && raw.balanceUsdMicros > 0n)) {
      throw new Error("expected zero live balance with Starter included set to 0");
    }
  } finally {
    await db
      .update(plans)
      .set({
        includedUsdMicros: previousIncluded,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(plans.id, starter.id));
    await syncPlanToOpenMeter(starter.id);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb({ timeout: 5 });
  });
