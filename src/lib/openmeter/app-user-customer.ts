import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import {
  appUserRetailCustomerKey,
  resolveOpenMeterBillingIdentity,
} from "@/lib/openmeter/billing-identity";
import {
  ensureOpenMeterCustomer,
  ensureOpenMeterCustomerForAppUser,
  findOpenMeterCustomerByKey,
} from "@/lib/openmeter/customers";

/**
 * Which OpenMeter customer an app-user request acts on:
 * - `payer` — `identity.payerCustomerKey`: meter subject, prepaid credits,
 *   included discount, settlement labels (the owner wallet under owner_rollup)
 * - `retail` — {@link appUserRetailCustomerKey}: payment methods and retail
 *   subscriptions (`eu_{end_users.id}` even under owner_rollup)
 */
export type AppUserCustomerRole = "payer" | "retail";

export type AppUserOpenMeterCustomer = { id: string; key: string };

/**
 * Resolve the app user's OpenMeter customer through billing identity — never
 * by rebuilding `app_…:externalUserId` or reading Neon `openmeter_customer_key`.
 *
 * `ensure: false` is a lookup (null when missing or OpenMeter is unavailable);
 * `ensure: true` creates the customer.
 */
export async function loadOpenMeterCustomerForAppUser(input: {
  clientId: string;
  externalUserId: string;
  role: AppUserCustomerRole;
  ensure: boolean;
}): Promise<AppUserOpenMeterCustomer | null> {
  if (!input.ensure && !isHostedAdminClientAvailable()) {
    return null;
  }
  const client = getHostedAdminClient();

  if (input.role === "payer" && input.ensure) {
    // Payer creation also attributes the owner wallet across the owner's apps.
    const customer = await ensureOpenMeterCustomerForAppUser({
      client,
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
    return { id: customer.id, key: customer.key };
  }

  const identity = await resolveOpenMeterBillingIdentity({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const customerKey =
    input.role === "retail"
      ? appUserRetailCustomerKey(identity)
      : identity.payerCustomerKey;

  if (input.ensure) {
    const customer = await ensureOpenMeterCustomer(client, customerKey);
    return { id: customer.id, key: customer.key };
  }
  const customer = await findOpenMeterCustomerByKey(client, customerKey);
  const id = customer?.id?.trim();
  if (!customer || !id) {
    return null;
  }
  return { id, key: customer.key?.trim() || customerKey };
}
