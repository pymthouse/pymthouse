/**
 * Durable invoice event ledger (outbox) + merchant invoice mapping helpers.
 */
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/index";
import { invoiceEvents, merchantInvoices } from "@/db/schema";

export type InvoiceEventSource = "openmeter" | "stripe";
export type InvoiceEventStatus =
  | "pending"
  | "processing"
  | "done"
  | "failed"
  | "dead";

export const MAX_INVOICE_EVENT_ATTEMPTS = 12;

/** Insert event; returns true if newly inserted, false on duplicate. */
export async function insertInvoiceEvent(input: {
  source: InvoiceEventSource;
  externalEventId: string;
  eventType: string;
  payload: unknown;
}): Promise<{ inserted: boolean; id: string }> {
  const id = uuidv4();
  const now = new Date().toISOString();
  try {
    await db.insert(invoiceEvents).values({
      id,
      source: input.source,
      externalEventId: input.externalEventId,
      eventType: input.eventType,
      payload: input.payload as Record<string, unknown>,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { inserted: true, id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(message)) {
      return { inserted: false, id };
    }
    throw err;
  }
}

function backoffSeconds(attempts: number): number {
  // 5s, 15s, 45s, … capped at 1h
  return Math.min(3600, 5 * 3 ** Math.max(0, attempts - 1));
}

/**
 * Claim a batch of pending (or retryable failed) events with SKIP LOCKED.
 * Safe for multiple Railway worker replicas.
 */
export async function claimInvoiceEvents(input: {
  workerId: string;
  limit?: number;
}): Promise<Array<typeof invoiceEvents.$inferSelect>> {
  const limit = input.limit ?? 10;
  const now = new Date().toISOString();
  const rows = await db.execute(sql`
    UPDATE invoice_events
    SET
      status = 'processing',
      claimed_by = ${input.workerId},
      attempts = attempts + 1,
      updated_at = ${now}
    WHERE id IN (
      SELECT id FROM invoice_events
      WHERE status IN ('pending', 'failed')
        AND next_attempt_at <= ${now}
        AND attempts < ${MAX_INVOICE_EVENT_ATTEMPTS}
      ORDER BY next_attempt_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING *
  `);

  // postgres.js / drizzle execute returns RowList; normalize to array of records.
  const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  return list.map((row) => normalizeClaimedRow(row as Record<string, unknown>));
}

function normalizeClaimedRow(
  row: Record<string, unknown>,
): typeof invoiceEvents.$inferSelect {
  return {
    id: String(row.id),
    source: String(row.source),
    externalEventId: String(row.external_event_id ?? row.externalEventId),
    eventType: String(row.event_type ?? row.eventType),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: String(row.status),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: String(row.next_attempt_at ?? row.nextAttemptAt ?? ""),
    claimedBy: row.claimed_by != null ? String(row.claimed_by) : (row.claimedBy as string | null),
    lastError: row.last_error != null ? String(row.last_error) : (row.lastError as string | null),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? ""),
  };
}

export async function markInvoiceEventDone(id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(invoiceEvents)
    .set({
      status: "done",
      claimedBy: null,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(invoiceEvents.id, id));
}

export async function markInvoiceEventFailed(input: {
  id: string;
  error: string;
  attempts: number;
}): Promise<void> {
  const now = new Date();
  const dead = input.attempts >= MAX_INVOICE_EVENT_ATTEMPTS;
  const next = new Date(
    now.getTime() + backoffSeconds(input.attempts) * 1000,
  ).toISOString();
  await db
    .update(invoiceEvents)
    .set({
      status: dead ? "dead" : "failed",
      claimedBy: null,
      lastError: input.error.slice(0, 2000),
      nextAttemptAt: next,
      updatedAt: now.toISOString(),
    })
    .where(eq(invoiceEvents.id, input.id));
}

export async function upsertMerchantInvoice(input: {
  openmeterInvoiceId: string;
  appId: string;
  openmeterCustomerId?: string | null;
  stripeConnectedAccountId?: string | null;
  stripeCustomerId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeInvoiceId?: string | null;
  state?: string;
  amountUsdMicros?: string | null;
  currency?: string;
  applicationFeeAmount?: number;
  lastError?: string | null;
}): Promise<typeof merchantInvoices.$inferSelect> {
  const now = new Date().toISOString();
  const existing = await db
    .select()
    .from(merchantInvoices)
    .where(eq(merchantInvoices.openmeterInvoiceId, input.openmeterInvoiceId))
    .limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(merchantInvoices)
      .set({
        openmeterCustomerId:
          input.openmeterCustomerId ?? existing[0].openmeterCustomerId,
        stripeConnectedAccountId:
          input.stripeConnectedAccountId ?? existing[0].stripeConnectedAccountId,
        stripeCustomerId: input.stripeCustomerId ?? existing[0].stripeCustomerId,
        stripePaymentIntentId:
          input.stripePaymentIntentId ?? existing[0].stripePaymentIntentId,
        stripeInvoiceId: input.stripeInvoiceId ?? existing[0].stripeInvoiceId,
        state: input.state ?? existing[0].state,
        amountUsdMicros: input.amountUsdMicros ?? existing[0].amountUsdMicros,
        currency: input.currency ?? existing[0].currency,
        applicationFeeAmount:
          input.applicationFeeAmount ?? existing[0].applicationFeeAmount,
        lastError: input.lastError === undefined ? existing[0].lastError : input.lastError,
        updatedAt: now,
      })
      .where(eq(merchantInvoices.id, existing[0].id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(merchantInvoices)
    .values({
      id: uuidv4(),
      openmeterInvoiceId: input.openmeterInvoiceId,
      appId: input.appId,
      openmeterCustomerId: input.openmeterCustomerId ?? null,
      stripeConnectedAccountId: input.stripeConnectedAccountId ?? null,
      stripeCustomerId: input.stripeCustomerId ?? null,
      stripePaymentIntentId: input.stripePaymentIntentId ?? null,
      stripeInvoiceId: input.stripeInvoiceId ?? null,
      state: input.state ?? "created",
      amountUsdMicros: input.amountUsdMicros ?? null,
      currency: input.currency ?? "USD",
      applicationFeeAmount: input.applicationFeeAmount ?? 0,
      lastError: input.lastError ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}

export async function getMerchantInvoiceByOmId(
  openmeterInvoiceId: string,
): Promise<typeof merchantInvoices.$inferSelect | null> {
  const rows = await db
    .select()
    .from(merchantInvoices)
    .where(eq(merchantInvoices.openmeterInvoiceId, openmeterInvoiceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMerchantInvoiceByPaymentIntent(
  paymentIntentId: string,
): Promise<typeof merchantInvoices.$inferSelect | null> {
  const rows = await db
    .select()
    .from(merchantInvoices)
    .where(eq(merchantInvoices.stripePaymentIntentId, paymentIntentId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMerchantInvoicesForApp(input: {
  appId: string;
  limit?: number;
}): Promise<Array<typeof merchantInvoices.$inferSelect>> {
  return db
    .select()
    .from(merchantInvoices)
    .where(eq(merchantInvoices.appId, input.appId))
    .orderBy(asc(merchantInvoices.createdAt))
    .limit(input.limit ?? 100);
}

/** Stuck invoices for sweeper: payment pending / syncing older than threshold. */
export async function listStuckMerchantInvoices(input: {
  olderThanIso: string;
  limit?: number;
}): Promise<Array<typeof merchantInvoices.$inferSelect>> {
  return db
    .select()
    .from(merchantInvoices)
    .where(
      and(
        or(
          eq(merchantInvoices.state, "payment_processing.pending"),
          eq(merchantInvoices.state, "draft.syncing"),
          eq(merchantInvoices.state, "issuing.syncing"),
          eq(merchantInvoices.state, "charge_initiated"),
        ),
        lte(merchantInvoices.updatedAt, input.olderThanIso),
      ),
    )
    .limit(input.limit ?? 50);
}
