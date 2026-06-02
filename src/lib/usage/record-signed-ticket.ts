import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { appUsers, usageIngestReceipts } from "@/db/schema";
import { provisionAppUserBilling } from "@/lib/billing/provision-app-user";
import { getOpenMeterClientForApp } from "@/lib/openmeter/client-factory";
import { ingestSignedTicketEvent } from "@/lib/openmeter/entitlements";
import { applyTenantBillingProfileToCustomer } from "@/lib/openmeter/billing-profiles";
import { ensureOpenMeterCustomerForAppUser } from "@/lib/openmeter/customers";
import { isOpenMeterEnabled } from "@/lib/openmeter/constants";

export async function resolveOrCreateAppUser(input: {
  clientId: string;
  externalUserId: string;
}): Promise<{ id: string; externalUserId: string }> {
  const externalUserId = input.externalUserId.trim();
  const newUser = {
    id: uuidv4(),
    clientId: input.clientId,
    externalUserId,
    email: null,
    status: "active",
    role: "user",
    createdAt: new Date().toISOString(),
  };

  const upserted = await db
    .insert(appUsers)
    .values(newUser)
    .onConflictDoUpdate({
      target: [appUsers.clientId, appUsers.externalUserId],
      set: { role: "user" },
    })
    .returning();

  const row = upserted[0] ?? newUser;
  return { id: row.id, externalUserId: row.externalUserId };
}

export type RecordSignedTicketInput = {
  clientId: string;
  externalUserId: string;
  requestId: string;
  networkFeeUsdMicros: bigint;
  feeWei?: string;
  pixels?: string;
  pipeline?: string;
  modelId?: string;
  gatewayRequestId?: string;
  ethUsdPrice?: string;
  ethUsdRoundId?: string;
  ethUsdObservedAt?: string;
};

export async function recordSignedTicketToOpenMeter(
  input: RecordSignedTicketInput,
): Promise<{ ingested: boolean; duplicate: boolean }> {
  if (!isOpenMeterEnabled()) {
    return { ingested: false, duplicate: false };
  }

  const existing = await db
    .select({ id: usageIngestReceipts.id })
    .from(usageIngestReceipts)
    .where(
      and(
        eq(usageIngestReceipts.clientId, input.clientId),
        eq(usageIngestReceipts.requestId, input.requestId),
      ),
    )
    .limit(1);

  if (existing[0]) {
    return { ingested: false, duplicate: true };
  }

  await provisionAppUserBilling({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });

  const client = await getOpenMeterClientForApp(input.clientId);
  if (!client) {
    return { ingested: false, duplicate: false };
  }

  const customer = await ensureOpenMeterCustomerForAppUser({
    client,
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  await applyTenantBillingProfileToCustomer({
    client,
    clientId: input.clientId,
    customerId: customer.id,
  });

  const eventId = input.requestId;
  await ingestSignedTicketEvent({
    client,
    event: {
      requestId: eventId,
      clientId: input.clientId,
      externalUserId: input.externalUserId,
      networkFeeUsdMicros: input.networkFeeUsdMicros.toString(),
      feeWei: input.feeWei,
      pixels: input.pixels,
      pipeline: input.pipeline,
      modelId: input.modelId,
      gatewayRequestId: input.gatewayRequestId,
      ethUsdPrice: input.ethUsdPrice,
      ethUsdRoundId: input.ethUsdRoundId,
      ethUsdObservedAt: input.ethUsdObservedAt,
    },
  });

  await db.insert(usageIngestReceipts).values({
    id: uuidv4(),
    clientId: input.clientId,
    requestId: input.requestId,
    openmeterEventId: eventId,
    externalUserId: input.externalUserId,
    createdAt: new Date().toISOString(),
  });

  return { ingested: true, duplicate: false };
}
