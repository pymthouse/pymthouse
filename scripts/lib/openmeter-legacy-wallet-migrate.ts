/**
 * Shared legacy-wallet helpers for OpenMeter customer migration scripts.
 * Keep scripts thin so Sonar does not flag duplicated migrate boilerplate.
 */
import { getHostedAdminClient } from "../../src/lib/openmeter/admin-client";
import {
  createKonnectCreditGrant,
  getKonnectCreditBalance,
} from "../../src/lib/openmeter/konnect-credits";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
} from "../../src/lib/openmeter/subscription-read";
import {
  readKonnectSubjectKeys,
  replaceKonnectCustomerSubjectKeys,
} from "./openmeter-konnect-migrate";

type AdminClient = ReturnType<typeof getHostedAdminClient>;

export async function findCustomerIdByKey(
  client: AdminClient,
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

export async function transferLegacyWalletBalance(input: {
  legacyCustomerId: string;
  legacyKey: string;
  targetCustomerId: string;
  targetKey: string;
  featureKey: string;
  grantName: string;
  idempotencyKey: string;
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
    name: input.grantName,
    description: `Transferred from legacy ${input.legacyKey}`,
    featureKey: input.featureKey,
    idempotencyKey: input.idempotencyKey,
    apiKey: input.apiKey,
  });
  console.log(
    `  [ok] granted ${balance.balanceUsdMicros.toString()} onto ${input.targetKey}`,
  );
  return balance.balanceUsdMicros;
}

export async function cancelLegacySubscriptions(input: {
  client: AdminClient;
  customerId: string;
  customerKey: string;
  dryRun: boolean;
}): Promise<number> {
  const listed = await listOpenMeterSubscriptionsForCustomer(
    input.client,
    input.customerId,
  );
  let cancels = 0;
  for (const sub of listed) {
    const status = (sub.status ?? "").toLowerCase();
    // Konnect rejects cancel for `scheduled` ("transition cancel in state
    // scheduled not allowed"). Only attempt live/pending rows.
    if (status === "scheduled") {
      console.warn(
        `  [skip] scheduled subscription ${sub.id} on legacy ${input.customerKey} ` +
          "(Konnect cannot cancel scheduled; leave for dual-read / later cleanup)",
      );
      continue;
    }
    if (!isOpenMeterSubscriptionActive(sub.status)) {
      continue;
    }
    if (input.dryRun) {
      console.log(
        `  [dry-run] would cancel ${sub.id} (${status}) on legacy ${input.customerKey}`,
      );
      cancels += 1;
      continue;
    }
    try {
      await input.client.subscriptions.cancel(sub.id, { timing: "immediate" });
      console.log(`  [cancel] ${sub.id} on legacy ${input.customerKey}`);
      cancels += 1;
    } catch (err) {
      console.warn(
        `  [warn] could not cancel ${sub.id} (${status}) on legacy ${input.customerKey}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return cancels;
}

export async function releaseLegacySubjectKeys(input: {
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
