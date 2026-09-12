/**
 * Repair bare owner customers that are missing their settlement subject key.
 *
 * Symptom (per-request log noise on /billing/dashboard, /me/credits):
 *   openmeter: skip subject key update <uuid> <uuid> … [400]: cannot change
 *   subject keys for customer with active subscriptions
 *
 * Root cause: the bare owner customer (key = users.id) has no `subject_keys`
 * (usually from earlier dedupe/migrate churn), so settlement events on the
 * bare subject do not attribute. `ensureOwnerCustomer` keeps trying to attach
 * the bare key, but an active subscription makes Konnect reject the change.
 *
 * Fix (DESTRUCTIVE — resets billing anchor): cancel active subs, release the
 * legacy `owner:{id}` wallet so `owner:` is free, PUT the bare customer's
 * subject_keys to [bareId (+ owner:bareId)], then re-provision Owner Starter.
 *
 * Usage:
 *   npx tsx scripts/openmeter-repair-owner-subject-keys.ts --owner-id <id>
 *   npx tsx scripts/openmeter-repair-owner-subject-keys.ts --owner-id <id> --apply
 *   npx tsx scripts/openmeter-repair-owner-subject-keys.ts --all
 *   npx tsx scripts/openmeter-repair-owner-subject-keys.ts --all --apply
 *   npx tsx scripts/openmeter-repair-owner-subject-keys.ts --owner-id <id> --bare-only --apply
 */
import "./load-env-first";

import { closeDb, db } from "../src/db/index";
import { developerApps } from "../src/db/schema";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "../src/lib/openmeter/admin-client";
import {
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
} from "../src/lib/openmeter/customer-key";
import {
  findOpenMeterCustomerByKey,
  listOwnedPublicClientIds,
} from "../src/lib/openmeter/customers";
import { ensureOwnerStarterSubscription } from "../src/lib/openmeter/owner-starter-plan";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
} from "../src/lib/openmeter/subscription-read";
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
  bareOnly: boolean;
};

type KonnectConfig = { baseUrl: string; apiKey: string };

type OwnerAssessment = {
  ownerId: string;
  bareKey: string;
  customerId: string | null;
  subjectKeys: string[];
  activeSubIds: string[];
  needsRepair: boolean;
};

function usage(): string {
  return [
    "openmeter-repair-owner-subject-keys",
    "",
    "Repair bare owner customers missing their settlement subject key.",
    "Default is dry-run. --apply cancels active subs and re-provisions (DESTRUCTIVE).",
    "",
    "Options:",
    "  --owner-id <users.id>   One owner",
    "  --all                   Scan every distinct app owner",
    "  --limit <n>             Cap owners when neither --all nor --owner-id (default 50)",
    "  --bare-only             Only attach the bare id (skip owner: + legacy release)",
    "  --apply                 Perform the destructive repair",
    "  --help",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    all: false,
    limit: 50,
    apply: false,
    bareOnly: false,
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
      case "--bare-only":
        args.bareOnly = true;
        break;
      case "--apply":
        args.apply = true;
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
  return args.all ? ids : ids.slice(0, args.limit);
}

function desiredSubjectKeys(ownerId: string, bareOnly: boolean): string[] {
  const bare = buildOwnerCustomerKey(ownerId);
  if (bareOnly) {
    return [bare];
  }
  return [bare, buildOwnerWireSubject(ownerId)];
}

async function assessOwner(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  baseUrl: string;
  apiKey: string;
  ownerId: string;
}): Promise<OwnerAssessment> {
  const bareKey = buildOwnerCustomerKey(input.ownerId);
  const found = await findOpenMeterCustomerByKey(input.client, bareKey);
  if (!found?.id) {
    return {
      ownerId: input.ownerId,
      bareKey,
      customerId: null,
      subjectKeys: [],
      activeSubIds: [],
      needsRepair: false,
    };
  }

  const current = await getKonnectCustomer(
    input.baseUrl,
    input.apiKey,
    found.id,
  );
  const subjectKeys = readKonnectSubjectKeys(current);
  const subs = await listOpenMeterSubscriptionsForCustomer(
    input.client,
    found.id,
  );
  const activeSubIds = subs
    .filter((sub) => isOpenMeterSubscriptionActive(sub.status))
    .map((sub) => sub.id);

  return {
    ownerId: input.ownerId,
    bareKey,
    customerId: found.id,
    subjectKeys,
    activeSubIds,
    needsRepair: !subjectKeys.includes(bareKey),
  };
}

async function releaseLegacyOwnerWallet(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  baseUrl: string;
  apiKey: string;
  ownerId: string;
}): Promise<void> {
  const legacyKey = buildOwnerWireSubject(input.ownerId);
  const legacy = await findOpenMeterCustomerByKey(input.client, legacyKey);
  if (!legacy?.id) {
    return;
  }
  const retired = `deprecated:${legacyKey}`;
  const current = await getKonnectCustomer(input.baseUrl, input.apiKey, legacy.id);
  const subjectKeys = readKonnectSubjectKeys(current);
  if (subjectKeys.length === 1 && subjectKeys[0] === retired) {
    return;
  }
  await replaceKonnectCustomerSubjectKeys({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    customerId: legacy.id,
    name: `Legacy ${legacyKey}`,
    subjectKeys: [retired],
  });
  console.log(`  [ok] released legacy ${legacyKey} → ${retired}`);
}

async function applyRepair(input: {
  client: ReturnType<typeof getHostedAdminClient>;
  config: KonnectConfig;
  assessment: OwnerAssessment;
  bareOnly: boolean;
}): Promise<boolean> {
  const { assessment, config, client } = input;
  if (!assessment.customerId) {
    return false;
  }

  for (const subId of assessment.activeSubIds) {
    await client.subscriptions.cancel(subId, { timing: "immediate" });
    console.log(`  [cancel] active sub ${subId}`);
  }

  if (!input.bareOnly) {
    await releaseLegacyOwnerWallet({
      client,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ownerId: assessment.ownerId,
    });
  }

  const desired = desiredSubjectKeys(assessment.ownerId, input.bareOnly);
  const updated = await replaceKonnectCustomerSubjectKeys({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    customerId: assessment.customerId,
    name: `Owner ${assessment.ownerId}`,
    subjectKeys: desired,
  });
  const after = readKonnectSubjectKeys(updated);
  if (!after.includes(assessment.bareKey)) {
    console.warn(
      `  [fail] bare key still missing after update: ${JSON.stringify(after)}`,
    );
    return false;
  }
  console.log(`  [ok] set subject_keys=${JSON.stringify(after)}`);

  const publicClientIds = await listOwnedPublicClientIds(assessment.ownerId);
  const provisioned = await ensureOwnerStarterSubscription({
    ownerUserId: assessment.ownerId,
    publicClientIds,
  });
  console.log(
    `  [ok] Owner Starter sub=${provisioned.openmeterSubscriptionId} created=${provisioned.created}`,
  );
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!isHostedAdminClientAvailable()) {
    throw new Error("OpenMeter is not configured");
  }
  const config = requireKonnectConfig();
  const client = getHostedAdminClient();
  const ownerIds = await listOwnerIds(args);
  console.log(
    `Scanning owners=${ownerIds.length} apply=${args.apply} bareOnly=${args.bareOnly}`,
  );

  let healthy = 0;
  let missingCustomer = 0;
  let repaired = 0;
  let planned = 0;
  let failed = 0;

  for (const ownerId of ownerIds) {
    const assessment = await assessOwner({
      client,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ownerId,
    });

    if (!assessment.customerId) {
      missingCustomer += 1;
      continue;
    }
    if (!assessment.needsRepair) {
      healthy += 1;
      continue;
    }

    console.log(
      `\n[owner] ${ownerId} customer=${assessment.customerId} subjectKeys=${JSON.stringify(assessment.subjectKeys)} activeSubs=${assessment.activeSubIds.length}`,
    );

    if (!args.apply) {
      planned += 1;
      const desired = desiredSubjectKeys(ownerId, args.bareOnly);
      console.log(
        `  [dry-run] would cancel ${assessment.activeSubIds.length} active sub(s), set subject_keys=${JSON.stringify(desired)}, re-provision Owner Starter`,
      );
      continue;
    }

    const ok = await applyRepair({
      client,
      config,
      assessment,
      bareOnly: args.bareOnly,
    });
    if (ok) repaired += 1;
    else failed += 1;
  }

  console.log(
    `\nDone owners=${ownerIds.length} healthy=${healthy} missingCustomer=${missingCustomer} planned=${planned} repaired=${repaired} failed=${failed} apply=${args.apply}`,
  );
  if (failed > 0) {
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
