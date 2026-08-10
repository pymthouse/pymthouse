/**
 * Thin wrapper: run Custom Invoicing bootstrap in e2e-only mode
 * (isolated Konnect notification channel + rules; no app/profile mutation).
 *
 * Equivalent to:
 *   SETTLEMENT_E2E_BOOTSTRAP=1 npx tsx scripts/openmeter-custom-invoicing-bootstrap.ts --e2e
 */
process.env.SETTLEMENT_E2E_BOOTSTRAP = "1";

if (!process.argv.includes("--e2e")) {
  process.argv.push("--e2e");
}

import("./openmeter-custom-invoicing-bootstrap").catch((err: unknown) => {
  console.error("[e2e-bootstrap] failed:", err);
  process.exit(1);
});
