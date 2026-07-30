/**
 * Railway entrypoint for the merchant Custom Invoicing worker.
 * Usage: npm run invoicing:worker
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

import { closeDb } from "../src/db/index";
import { runInvoicingWorker } from "../src/lib/invoicing/worker";

async function main(): Promise<void> {
  const stop = async () => {
    console.log("[invoicing-worker] shutting down…");
    await closeDb({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });

  await runInvoicingWorker();
}

main().catch(async (err) => {
  console.error("[invoicing-worker] fatal:", err);
  await closeDb({ timeout: 2 }).catch(() => undefined);
  process.exit(1);
});
