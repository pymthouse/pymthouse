/**
 * Move cardless customers off Stripe-backed billing profiles onto the free one.
 *
 * The old provisioning path pinned every customer to a Stripe billing profile
 * before subscribing them to Starter, so Konnect now rejects their Starter
 * subscription with "stripe customer must have a default payment method". The
 * runtime recovers from that 409 on its own, but each stuck customer burns a
 * failed mint first — for owners that surfaces as a 503 from the signer. This
 * sweep applies the same recovery ahead of time.
 *
 * Only customers with no default payment method and no active subscription are
 * touched: an active subscription means Konnect already accepted the billing
 * setup, and a payment method means the customer belongs on Stripe.
 *
 * Usage:
 *   npx tsx scripts/openmeter-unpin-cardless-customers.ts
 *   npx tsx scripts/openmeter-unpin-cardless-customers.ts --apply
 */
import "./load-env-first";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import {
  applyFreeBillingProfileToCustomer,
  ensureFreeBillingProfile,
} from "../src/lib/openmeter/billing-profiles";
import {
  getKonnectCustomerBillingProfileId,
  getKonnectStripeBillingRefs,
} from "../src/lib/openmeter/stripe-customer-data";
import { listOpenMeterSubscriptionsForCustomer } from "../src/lib/openmeter/subscription-read";
import { sanitizeForLog } from "../src/lib/sanitize-for-log";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

async function listAllCustomers(): Promise<Array<{ id: string; key?: string }>> {
  const client = getHostedAdminClient();
  const all: Array<{ id: string; key?: string }> = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const listed = await client.customers.list({ page, pageSize: PAGE_SIZE });
    const items =
      (listed as { items?: Array<{ id: string; key?: string }> })?.items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) {
      return all;
    }
  }
  throw new Error(`Customer list exceeded ${MAX_PAGES} pages`);
}

async function hasActiveSubscription(customerId: string): Promise<boolean> {
  const client = getHostedAdminClient();
  const listed = await listOpenMeterSubscriptionsForCustomer(client, customerId);
  return listed.some(
    (sub) => sub.status === "active" || sub.status === "trialing",
  );
}

async function main(): Promise<void> {
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }
  const apply = process.argv.slice(2).includes("--apply");
  const client = getHostedAdminClient();
  const freeProfileId = await ensureFreeBillingProfile(client);
  console.log(`free billing profile: ${sanitizeForLog(freeProfileId)}`);

  const customers = await listAllCustomers();
  console.log(`scanning ${customers.length} customers`);

  let unpinned = 0;
  let skipped = 0;
  for (const customer of customers) {
    const profileId = await getKonnectCustomerBillingProfileId(customer.id);
    if (!profileId || profileId === freeProfileId) {
      skipped += 1;
      continue;
    }
    const refs = await getKonnectStripeBillingRefs(customer.id);
    if (refs.defaultPaymentMethodId) {
      skipped += 1;
      continue;
    }
    if (await hasActiveSubscription(customer.id)) {
      skipped += 1;
      continue;
    }

    console.log(
      `[${apply ? "apply" : "dry-run"}] ${sanitizeForLog(customer.key ?? customer.id)} customer=${sanitizeForLog(customer.id)} profile=${sanitizeForLog(profileId)} -> free`,
    );
    if (apply) {
      await applyFreeBillingProfileToCustomer({
        client,
        customerId: customer.id,
      });
    }
    unpinned += 1;
  }

  console.log(
    `Done. unpinned=${unpinned} skipped=${skipped}${apply ? "" : " (dry-run)"}`,
  );
}

main().catch((err) => {
  console.error(
    "[openmeter-unpin-cardless-customers] fatal:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
