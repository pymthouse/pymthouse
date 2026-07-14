/**
 * Create a zero-credit test user with starter idempotency key locked,
 * then mint a composite API key for balance-gate testing.
 *
 * Locks `starter:{customerId}:{feature}` with a short-lived $5 grant so staging
 * ensureTrialAllowance hits 409 instead of topping up to $5.
 */
import "./load-env-first";
import { closeDb } from "../src/db/index";
import { createAppUserApiKey } from "../src/lib/app-api-keys";
import { provisionAppUserBilling } from "../src/lib/billing/provision-app-user";
import { ensureOpenMeterCustomer } from "../src/lib/openmeter/customers";
import {
  getHostedTrialOpenMeterClient,
  getTrialFeatureKeyForApp,
} from "../src/lib/openmeter/client-factory";
import {
  createKonnectCreditGrant,
  getKonnectCreditBalance,
  listKonnectCreditGrants,
} from "../src/lib/openmeter/konnect-credits";
import { getTrialCreditBalance } from "../src/lib/openmeter/entitlements";
import { getProviderAppByClientId } from "../src/lib/provider-apps";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1]?.trim();
}

async function main() {
  process.env.OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS = "0";

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

  const provisioned = await provisionAppUserBilling({
    clientId,
    externalUserId,
  });

  const om = getHostedTrialOpenMeterClient();
  if (!om) throw new Error("OpenMeter not configured");
  const customer = await ensureOpenMeterCustomer(
    om,
    `${clientId}:${externalUserId}`,
  );
  const featureKey = await getTrialFeatureKeyForApp(clientId);
  const idempotencyKey = `starter:${customer.id}:${featureKey}`;

  const lock = await createKonnectCreditGrant({
    customerId: customer.id,
    amountUsdMicros: 5_000_000n,
    name: "Starter trial credits",
    description: "Balance-gate lock (expires in 10s)",
    featureKey,
    idempotencyKey,
    expiresAfter: "PT10S",
  });
  console.log("starter lock", lock);
  console.log("waiting for lock grant to expire...");
  await new Promise((r) => setTimeout(r, 12_000));

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
        idempotencyKey,
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
    throw new Error("expected zero live balance after lock expiry");
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
