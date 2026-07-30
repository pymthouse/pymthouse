/**
 * Railway invoicing worker: claim ledger events, run state machine, sweep stuck invoices.
 */
import {
  claimInvoiceEvents,
  listStuckMerchantInvoices,
  markInvoiceEventDone,
  markInvoiceEventFailed,
} from "@/lib/invoicing/ledger";
import {
  processInvoiceEvent,
  reconcileMerchantInvoice,
} from "@/lib/invoicing/state-machine";
import { sanitizeForLog } from "@/lib/sanitize-for-log";

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_SWEEP_MS = 60_000;
const STUCK_AGE_MS = 15 * 60 * 1000;

export type InvoicingWorkerOptions = {
  workerId?: string;
  pollIntervalMs?: number;
  sweepIntervalMs?: number;
  batchSize?: number;
  /** When true, run a single claim+sweep cycle then return (tests). */
  once?: boolean;
};

export async function runInvoicingWorker(
  options: InvoicingWorkerOptions = {},
): Promise<void> {
  const workerId =
    options.workerId ||
    process.env.INVOICING_WORKER_ID?.trim() ||
    `invoicing-${process.pid}`;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const sweepMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
  const batchSize = options.batchSize ?? 10;
  const tag = `[invoicing-worker:${workerId}]`;

  let lastSweep = 0;

  const cycle = async (): Promise<void> => {
    const claimed = await claimInvoiceEvents({
      workerId,
      limit: batchSize,
    });
    for (const event of claimed) {
      try {
        await processInvoiceEvent({
          source: event.source,
          eventType: event.eventType,
          payload: event.payload,
        });
        await markInvoiceEventDone(event.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          tag,
          `event ${event.id} (${event.eventType}) failed:`,
          sanitizeForLog(message),
        );
        await markInvoiceEventFailed({
          id: event.id,
          error: message,
          attempts: event.attempts,
        });
      }
    }

    const now = Date.now();
    if (now - lastSweep >= sweepMs) {
      lastSweep = now;
      await runSweeper(tag);
    }
  };

  if (options.once) {
    await cycle();
    return;
  }

  console.log(tag, "started");
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(tag, "cycle error:", sanitizeForLog(message));
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function runSweeper(tag: string): Promise<void> {
  const olderThanIso = new Date(Date.now() - STUCK_AGE_MS).toISOString();
  const stuck = await listStuckMerchantInvoices({
    olderThanIso,
    limit: 25,
  });
  for (const row of stuck) {
    try {
      await reconcileMerchantInvoice(row.openmeterInvoiceId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        tag,
        `sweep ${row.openmeterInvoiceId} failed:`,
        sanitizeForLog(message),
      );
    }
  }
  if (stuck.length > 0) {
    console.log(tag, `swept ${stuck.length} stuck merchant invoice(s)`);
  }
}
