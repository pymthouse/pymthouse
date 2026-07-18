/**
 * Finish incomplete legacy-owner subject-key releases.
 *
 * After migrate-owner-customers --cancel-legacy, some `owner:{users.id}` (and
 * compound) wallets still keep the live subject alongside `deprecated:…`.
 * That blocks transitional attribution on the bare owner customer (409) and
 * floods logs when ensureOwnerCustomer retries.
 *
 * This script finds those customers and PUT-replaces subject_keys with only
 * `deprecated:{customer.key}` (Konnect rejects empty subject_keys).
 *
 * Usage:
 *   # Dry-run all app owners (default when unscoped)
 *   npx tsx scripts/openmeter-release-legacy-subjects.ts --all
 *
 *   # One owner
 *   npx tsx scripts/openmeter-release-legacy-subjects.ts --owner-id <users.id>
 *
 *   # Apply
 *   npx tsx scripts/openmeter-release-legacy-subjects.ts --all --apply
 *   npx tsx scripts/openmeter-release-legacy-subjects.ts --owner-id <id> --apply
 */
import "./load-env-first";

import { closeDb, db } from "../src/db/index";
import { developerApps } from "../src/db/schema";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import {
  buildOpenMeterCustomerKey,
  buildOwnerWireSubject,
} from "../src/lib/openmeter/customer-key";
import {
  findOpenMeterCustomerByKey,
  listOwnedPublicClientIds,
} from "../src/lib/openmeter/customers";
import {
  getKonnectCustomer,
  readKonnectSubjectKeys,
  replaceKonnectCustomerSubjectKeys,
  requireKonnectConfig,
  takeArgValue,
} from "./lib/openmeter-konnect-migrate";

type Args = {
  ownerId?: string;
  all: boolean;
  limit: number;
  apply: boolean;
  verbose: boolean;
};

function usage(): string {
  return [
    "openmeter-release-legacy-subjects",
    "",
    "Replace incomplete legacy subject_keys with deprecated-only.",
    "Default is dry-run (no writes) unless --apply.",
    "",
    "Options:",
    "  --all                   Scan every distinct app owner (recommended)",
    "  --owner-id <users.id>   One owner",
    "  --limit <n>             Cap owners when neither --all nor --owner-id (default 50)",
    "  --apply                 Write changes",
    "  --verbose               Log every skip (default: only actionable lines)",
    "  --help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    all: false,
    limit: 50,
    apply: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--owner-id":
        args.ownerId = takeArgValue(argv, i, token);
        i += 1;
        break;
      case "--all":
        args.all = true;
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
      case "--apply":
        args.apply = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function retiredSubjectKey(customerKey: string): string {
  return `deprecated:${customerKey}`;
}

function needsRelease(customerKey: string, subjectKeys: string[]): boolean {
  if (subjectKeys.includes(customerKey)) {
    return true;
  }
  const retired = retiredSubjectKey(customerKey);
  if (subjectKeys.includes(retired) && subjectKeys.length > 1) {
    return true;
  }
  return false;
}

async function listOwnerIds(args: Args): Promise<string[]> {
  if (args.ownerId?.trim()) {
    return [args.ownerId.trim()];
  }

  const rows = await db
    .selectDistinct({ ownerId: developerApps.ownerId })
    .from(developerApps);
  const ids = rows
    .map((row) => row.ownerId?.trim())
    .filter((id): id is string => Boolean(id));

  if (args.all) {
    return ids;
  }
  return ids.slice(0, args.limit);
}

function legacyKeysForOwner(ownerId: string, publicClientIds: string[]): string[] {
  const wire = buildOwnerWireSubject(ownerId);
  const keys = [wire];
  for (const publicClientId of publicClientIds) {
    keys.push(
      buildOpenMeterCustomerKey(publicClientId, ownerId),
      buildOpenMeterCustomerKey(publicClientId, wire),
    );
  }
  return [...new Set(keys)];
}

async function releaseCustomer(input: {
  baseUrl: string;
  apiKey: string;
  customerId: string;
  customerKey: string;
  apply: boolean;
  verbose: boolean;
}): Promise<"ok" | "dry-run" | "skip" | "fail"> {
  const current = await getKonnectCustomer(
    input.baseUrl,
    input.apiKey,
    input.customerId,
  );
  const subjectKeys = readKonnectSubjectKeys(current);
  if (!needsRelease(input.customerKey, subjectKeys)) {
    if (input.verbose) {
      console.log(
        `  [skip] ${input.customerKey} already released subjectKeys=${JSON.stringify(subjectKeys)}`,
      );
    }
    return "skip";
  }

  const retired = retiredSubjectKey(input.customerKey);
  const name =
    current.name?.startsWith("Legacy ")
      ? current.name
      : `Legacy ${input.customerKey}`;

  if (!input.apply) {
    console.log(
      `  [dry-run] would release ${input.customerKey} id=${input.customerId} ${JSON.stringify(subjectKeys)} → [${retired}]`,
    );
    return "dry-run";
  }

  try {
    const updated = await replaceKonnectCustomerSubjectKeys({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      customerId: input.customerId,
      name,
      subjectKeys: [retired],
    });
    const after = readKonnectSubjectKeys(updated);
    if (
      after.includes(input.customerKey) ||
      after.length !== 1 ||
      after[0] !== retired
    ) {
      console.warn(
        `  [fail] release incomplete for ${input.customerKey}: got ${JSON.stringify(after)}`,
      );
      return "fail";
    }
    console.log(`  [ok] released ${input.customerKey} → ${retired}`);
    return "ok";
  } catch (err) {
    console.warn(
      `  [fail] ${input.customerKey}:`,
      err instanceof Error ? err.message : String(err),
    );
    return "fail";
  }
}

type ReleaseResult = "ok" | "dry-run" | "skip" | "fail";

type ScanTallies = {
  ok: number;
  dryRun: number;
  skip: number;
  missing: number;
  fail: number;
  ownersWithWork: number;
};

function emptyTallies(): ScanTallies {
  return {
    ok: 0,
    dryRun: 0,
    skip: 0,
    missing: 0,
    fail: 0,
    ownersWithWork: 0,
  };
}

function recordResult(tallies: ScanTallies, result: ReleaseResult): void {
  if (result === "ok") tallies.ok += 1;
  else if (result === "dry-run") tallies.dryRun += 1;
  else if (result === "skip") tallies.skip += 1;
  else tallies.fail += 1;
}

function logOwnerHeader(ownerId: string, appCount: number): void {
  console.log(`\n[owner] ${ownerId} apps=${appCount}`);
}

async function processOwner(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  baseUrl: string;
  apiKey: string;
  ownerId: string;
  apply: boolean;
  verbose: boolean;
  tallies: ScanTallies;
}): Promise<void> {
  const publicClientIds = await listOwnedPublicClientIds(input.ownerId);
  const keys = legacyKeysForOwner(input.ownerId, publicClientIds);
  let ownerLogged = false;
  let ownerHadWork = false;

  const maybeLogOwner = () => {
    if (ownerLogged) return;
    logOwnerHeader(input.ownerId, publicClientIds.length);
    ownerLogged = true;
  };

  for (const customerKey of keys) {
    const found = await findOpenMeterCustomerByKey(input.client, customerKey);
    if (!found?.id) {
      input.tallies.missing += 1;
      if (input.verbose) {
        maybeLogOwner();
        console.log(`  [skip] no customer ${customerKey}`);
      }
      continue;
    }

    const result = await releaseCustomer({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      customerId: found.id,
      customerKey,
      apply: input.apply,
      verbose: input.verbose,
    });

    if (result === "skip") {
      input.tallies.skip += 1;
      if (input.verbose) maybeLogOwner();
      continue;
    }

    maybeLogOwner();
    ownerHadWork = true;
    recordResult(input.tallies, result);
  }

  if (ownerHadWork) input.tallies.ownersWithWork += 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ownerId && !args.all) {
    console.log(
      "Tip: pass --all to scan every app owner (dry-run by default). Continuing with --limit.\n",
    );
  }
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }
  const { baseUrl, apiKey } = requireKonnectConfig();
  const client = getHostedAdminClient();
  const ownerIds = await listOwnerIds(args);
  console.log(
    `Scanning owners=${ownerIds.length} apply=${args.apply} verbose=${args.verbose}`,
  );

  const tallies = emptyTallies();
  for (const ownerId of ownerIds) {
    await processOwner({
      client,
      baseUrl,
      apiKey,
      ownerId,
      apply: args.apply,
      verbose: args.verbose,
      tallies,
    });
  }

  console.log(
    `\nDone owners=${ownerIds.length} ownersWithWork=${tallies.ownersWithWork} apply=${args.apply} ok=${tallies.ok} dryRun=${tallies.dryRun} skip=${tallies.skip} missing=${tallies.missing} fail=${tallies.fail}`,
  );
  if (tallies.fail > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
