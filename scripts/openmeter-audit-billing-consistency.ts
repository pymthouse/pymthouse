/**
 * Audit Neon ↔ OpenMeter/Konnect billing object consistency.
 *
 * Catches the relational drift that makes the mint/signer spendable gate return
 * HTTP 483 "Starter allowance exhausted" while dashboard usage still looks open:
 * stale Starter plan versions, unmapped owner subscriptions, missing
 * discounts.usage, and spendable=0 with unused included allowance.
 *
 * Usage:
 *   npx tsx scripts/openmeter-audit-billing-consistency.ts
 *   npx tsx scripts/openmeter-audit-billing-consistency.ts --owner-id <users.id>
 *   npx tsx scripts/openmeter-audit-billing-consistency.ts --client-id app_xxx
 *   npx tsx scripts/openmeter-audit-billing-consistency.ts --limit 20 --json
 *
 * Exit codes:
 *   0 — no error-severity findings
 *   1 — one or more error findings (or fatal script failure)
 */
import "./load-env-first";

import { closeDb } from "../src/db/index";
import {
  auditBillingConsistency,
  summarizeFindings,
  type BillingConsistencyFinding,
} from "../src/lib/openmeter/billing-consistency";
import { takeArgValue } from "./lib/openmeter-konnect-migrate";

type Args = {
  ownerId?: string;
  clientId?: string;
  limit: number;
  json: boolean;
};

function usage(): string {
  return [
    "openmeter-audit-billing-consistency",
    "",
    "Validate PymtHouse ↔ OpenMeter billing object relationships.",
    "",
    "Options:",
    "  --owner-id <users.id>   Audit one owner wallet",
    "  --client-id <app_…>     Audit the owner of one public client / app id",
    "  --limit <n>             Max owners when unscoped (default 50)",
    "  --json                  Print findings as JSON",
    "  --help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 50, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--owner-id":
        args.ownerId = takeArgValue(argv, i, token);
        i += 1;
        break;
      case "--client-id":
        args.clientId = takeArgValue(argv, i, token);
        i += 1;
        break;
      case "--limit": {
        const raw = takeArgValue(argv, i, token);
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error("--limit must be a positive integer");
        }
        args.limit = Math.floor(n);
        i += 1;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${token}\n\n${usage()}`);
    }
  }
  return args;
}

function formatFindingScope(f: BillingConsistencyFinding): string {
  const parts: string[] = [];
  if (f.ownerId) parts.push(`owner=${f.ownerId}`);
  if (f.clientId) parts.push(`client=${f.clientId}`);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

function printFinding(f: BillingConsistencyFinding): void {
  console.log(`[${f.severity.toUpperCase()}] ${f.code}${formatFindingScope(f)}`);
  console.log(`  ${f.message}`);
  if (f.remediation) {
    console.log(`  fix: ${f.remediation}`);
  }
  if (f.details && Object.keys(f.details).length > 0) {
    console.log(`  details: ${JSON.stringify(f.details)}`);
  }
}

function printHuman(findings: BillingConsistencyFinding[]): void {
  if (findings.length === 0) {
    console.log("OK — no consistency findings");
    return;
  }

  const order = ["error", "warn", "info"] as const;
  for (const severity of order) {
    for (const f of findings.filter((item) => item.severity === severity)) {
      printFinding(f);
    }
  }

  const summary = summarizeFindings(findings);
  console.log(
    `\nsummary: errors=${summary.errors} warns=${summary.warns} infos=${summary.infos}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const findings = await auditBillingConsistency({
    ownerId: args.ownerId,
    clientId: args.clientId,
    limit: args.limit,
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          findings,
          summary: summarizeFindings(findings),
        },
        null,
        2,
      ),
    );
  } else {
    printHuman(findings);
  }

  const { errors } = summarizeFindings(findings);
  process.exitCode = errors > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(
      "[openmeter-audit-billing-consistency] fatal:",
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
