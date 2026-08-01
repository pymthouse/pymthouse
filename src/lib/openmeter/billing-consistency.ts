/**
 * Relational consistency checks between PymtHouse (Neon) billing objects and
 * hosted OpenMeter/Konnect (customers, plans, subscriptions, spendable gate).
 *
 * Used by `scripts/openmeter-audit-billing-consistency.ts` and unit tests.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { OpenMeter } from "@openmeter/sdk";

import { db } from "@/db/index";
import { developerApps, oidcClients, plans, users } from "@/db/schema";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import {
  getHostedAdminClient,
  isHostedAdminClientAvailable,
} from "@/lib/openmeter/admin-client";
import { buildOwnerCustomerKey, buildOwnerMeterSubjects } from "@/lib/openmeter/customer-key";
import { ownerHasChargeablePaymentMethod } from "@/lib/openmeter/owner-payment-method";
import {
  findOpenMeterCustomerByKey,
  listOwnedPublicClientIds,
} from "@/lib/openmeter/customers";
import { getTrialCreditBalance } from "@/lib/openmeter/entitlements";
import {
  isOwnerStarterPlanKey,
  OWNER_STARTER_PLAN_KEY,
  ownerStarterIncludedUsdMicros,
} from "@/lib/openmeter/owner-starter-key";
import { buildOpenMeterPlanKey } from "@/lib/openmeter/plan-naming";
import {
  includedDiscountUsdMicrosForPlan,
  getRemainingPlanDiscountUsdMicros,
  getSpendableUsdMicros,
} from "@/lib/openmeter/spendable-allowance";
import {
  isOpenMeterSubscriptionActive,
  listOpenMeterSubscriptionsForCustomer,
  type OpenMeterSubscriptionView,
} from "@/lib/openmeter/subscription-read";
import {
  getHostedOpenMeterUrl,
  NETWORK_FEE_USD_MICROS_METER,
} from "@/lib/openmeter/constants";
import { meterRowValueToBigInt } from "@/lib/openmeter/usage-read";
import { defaultStarterIncludedUsdMicros } from "@/lib/starter-default-plan-display";
import {
  getKonnectCustomerBillingProfileId,
  getStripeCustomerAppDataId,
} from "@/lib/openmeter/stripe-customer-data";
import { shouldUseKonnectRoutes } from "@/lib/openmeter/route-mode";
import {
  countActiveKonnectSubscriptionsForPlan,
} from "@/lib/openmeter/konnect-subscriptions";

export type FindingSeverity = "error" | "warn" | "info";

export type BillingConsistencyFinding = {
  code: string;
  severity: FindingSeverity;
  message: string;
  ownerId?: string;
  clientId?: string;
  details?: Record<string, unknown>;
  remediation?: string;
};

export type LocalStarterPlanRef = {
  planId: string;
  developerAppId: string;
  publicClientId: string;
  appName: string;
  includedUsdMicros: string | null;
  openmeterPlanId: string | null;
  planKey: string;
};

export type RemotePlanSnapshot = {
  id: string;
  key: string | null;
  version?: number;
  /** Rate-card discounts.usage in USD micros, when present. */
  usageDiscountUsdMicros: string | null;
};

/** Remediation is always a separate ops script — never in-app migration. */
const FIX_STARTER =
  "npm run openmeter:fix-starter-allowance -- --owner-id <users.id> --apply";
const FIX_DEDUPE =
  "npm run openmeter:dedupe-owner-subscriptions -- --owner-id <users.id> --apply";
const FIX_MIGRATE =
  "npm run openmeter:migrate-owner-customers -- --owner-id <users.id> --provision --transfer-balances --cancel-legacy";
const FIX_SANDBOX_TO_STRIPE =
  "npm run openmeter:migrate-sandbox-to-stripe -- --apply";
const FIX_MIGRATE_PLAN_SUBSCRIBERS =
  "npm run openmeter:migrate-plan-subscribers -- --client-id <app_…> --from-plan <planId> --apply";

function parsePositiveMicros(raw: string | null | undefined): bigint | null {
  if (!raw?.trim()) return null;
  try {
    const value = BigInt(raw.trim());
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** Read discounts.usage from an OpenMeter/Konnect plan body (SDK or raw). */
export function readUsageDiscountUsdMicrosFromPlanBody(
  plan: unknown,
): string | null {
  if (!plan || typeof plan !== "object") return null;
  const phases = readPlanPhases(plan);
  if (!phases) return null;

  for (const phase of phases) {
    const micros = readUsageDiscountFromPhase(phase);
    if (micros != null) return micros;
  }
  return null;
}

function readPlanPhases(plan: object): unknown[] | null {
  const phases =
    (plan as { phases?: unknown }).phases ??
    (plan as { Phases?: unknown }).Phases;
  return Array.isArray(phases) ? phases : null;
}

function readUsageDiscountFromPhase(phase: unknown): string | null {
  if (!phase || typeof phase !== "object") return null;
  const cards =
    (phase as { rateCards?: unknown }).rateCards ??
    (phase as { rate_cards?: unknown }).rate_cards ??
    [];
  if (!Array.isArray(cards)) return null;
  for (const card of cards) {
    const micros = readUsageDiscountFromRateCard(card);
    if (micros != null) return micros;
  }
  return null;
}

function readUsageDiscountFromRateCard(card: unknown): string | null {
  if (!card || typeof card !== "object") return null;
  const discounts = (card as { discounts?: unknown }).discounts;
  if (!discounts || typeof discounts !== "object") return null;
  const usage =
    (discounts as { usage?: unknown }).usage ??
    (discounts as { Usage?: unknown }).Usage;
  if (typeof usage === "number" && Number.isFinite(usage)) {
    return String(Math.trunc(usage));
  }
  if (typeof usage === "string" && /^\d+$/.test(usage.trim())) {
    return usage.trim();
  }
  return null;
}

/**
 * Classify a local Starter row against its remote OpenMeter plan snapshot.
 * Pure — no I/O. Returns zero or more findings.
 */
export function classifyStarterPlanRemoteConsistency(input: {
  local: LocalStarterPlanRef;
  remote: RemotePlanSnapshot | null;
}): BillingConsistencyFinding[] {
  const findings: BillingConsistencyFinding[] = [];
  const { local, remote } = input;
  const expected = includedDiscountUsdMicrosForPlan({
    includedUsdMicros: local.includedUsdMicros,
    isStarterDefault: true,
  });

  if (!local.openmeterPlanId?.trim()) {
    findings.push({
      code: "starter_openmeter_plan_id_missing",
      severity: "error",
      clientId: local.publicClientId,
      message: `Starter plan ${local.planId} has no openmeterPlanId (not synced)`,
      details: { planKey: local.planKey, appName: local.appName },
      remediation: "Sync/publish the Starter plan, then re-run this audit",
    });
    return findings;
  }

  if (!remote) {
    findings.push({
      code: "starter_openmeter_plan_missing",
      severity: "error",
      clientId: local.publicClientId,
      message: `Konnect plan ${local.openmeterPlanId} not found for local Starter`,
      details: { planKey: local.planKey, openmeterPlanId: local.openmeterPlanId },
      remediation: FIX_STARTER,
    });
    return findings;
  }

  if (remote.key && remote.key !== local.planKey) {
    findings.push({
      code: "starter_plan_key_mismatch",
      severity: "warn",
      clientId: local.publicClientId,
      message: `Local plan key ${local.planKey} ≠ remote key ${remote.key}`,
      details: {
        localPlanKey: local.planKey,
        remotePlanKey: remote.key,
        openmeterPlanId: local.openmeterPlanId,
      },
    });
  }

  if (expected != null && remote.usageDiscountUsdMicros == null) {
    findings.push({
      code: "starter_missing_usage_discount",
      severity: "error",
      clientId: local.publicClientId,
      message:
        `Remote Starter ${remote.id} has no rate-card discounts.usage ` +
        `(local included ${expected} micros)`,
      details: {
        openmeterPlanId: remote.id,
        version: remote.version,
        expectedIncludedUsdMicros: expected.toString(),
      },
      remediation: FIX_STARTER,
    });
  } else if (
    expected != null &&
    remote.usageDiscountUsdMicros != null &&
    BigInt(remote.usageDiscountUsdMicros) !== expected
  ) {
    findings.push({
      code: "starter_usage_discount_mismatch",
      severity: "warn",
      clientId: local.publicClientId,
      message:
        `Remote discounts.usage=${remote.usageDiscountUsdMicros} ≠ ` +
        `local included=${expected}`,
      details: {
        openmeterPlanId: remote.id,
        remoteUsageDiscountUsdMicros: remote.usageDiscountUsdMicros,
        localIncludedUsdMicros: expected.toString(),
      },
      remediation: FIX_STARTER,
    });
  }

  return findings;
}

/**
 * Classify an owner wallet's active subscription against the platform Owner
 * Starter plan (and legacy per-app Starters during transition). Pure — no I/O.
 */
export function classifyOwnerSubscriptionMapping(input: {
  ownerId: string;
  subscription: Pick<OpenMeterSubscriptionView, "id" | "status" | "planId" | "planKey">;
  /** Remote plan for subscription.planId (null if fetch failed). */
  remotePlan: RemotePlanSnapshot | null;
  ownedStarters: LocalStarterPlanRef[];
}): BillingConsistencyFinding[] {
  const findings: BillingConsistencyFinding[] = [];
  const { ownerId, subscription, remotePlan, ownedStarters } = input;
  const planId = subscription.planId?.trim() || null;
  const planKey = subscription.planKey?.trim() || remotePlan?.key?.trim() || null;

  if (!planId) {
    findings.push({
      code: "owner_subscription_missing_plan_id",
      severity: "error",
      ownerId,
      message: `Active subscription ${subscription.id} has no planId`,
      remediation: FIX_MIGRATE,
    });
    return findings;
  }

  // Canonical: platform Owner Starter plan.
  if (isOwnerStarterPlanKey(planKey)) {
    const expected = parsePositiveMicros(ownerStarterIncludedUsdMicros());
    const remoteMicros = remotePlan?.usageDiscountUsdMicros?.trim() || null;
    if (remoteMicros == null || remoteMicros === "") {
      findings.push({
        code: "owner_starter_missing_usage_discount",
        severity: "error",
        ownerId,
        message: `Owner Starter plan ${planId} has no rate-card discounts.usage`,
        details: {
          subscriptionId: subscription.id,
          planKey: OWNER_STARTER_PLAN_KEY,
          expectedIncludedUsdMicros: ownerStarterIncludedUsdMicros(),
        },
        remediation: FIX_MIGRATE,
      });
    } else if (expected != null && BigInt(remoteMicros) !== expected) {
      findings.push({
        code: "owner_starter_usage_discount_mismatch",
        severity: "warn",
        ownerId,
        message:
          `Owner Starter discounts.usage=${remoteMicros} ≠ ` +
          `canonical ${expected}`,
        details: {
          subscriptionId: subscription.id,
          planKey: OWNER_STARTER_PLAN_KEY,
          remoteUsageDiscountUsdMicros: remoteMicros,
          expectedIncludedUsdMicros: expected.toString(),
        },
        remediation: FIX_MIGRATE,
      });
    }
    return findings;
  }

  // Legacy: still on a per-app Starter — warn to migrate.
  if (ownedStarters.some((s) => s.openmeterPlanId === planId)) {
    findings.push({
      code: "owner_subscription_legacy_app_starter",
      severity: "warn",
      ownerId,
      message:
        `Owner sub ${subscription.id} is still on a per-app Starter — migrate to ` +
        `${OWNER_STARTER_PLAN_KEY}`,
      details: {
        subscriptionId: subscription.id,
        subscriptionPlanId: planId,
        planKey,
      },
      remediation: FIX_MIGRATE,
    });
    return findings;
  }

  const byKey = planKey
    ? ownedStarters.find((s) => s.planKey === planKey)
    : undefined;

  if (byKey) {
    findings.push({
      code: "starter_subscription_stale_plan_version",
      severity: "error",
      ownerId,
      clientId: byKey.publicClientId,
      message:
        `Owner sub ${subscription.id} is on plan ${planId} but local Starter ` +
        `points at ${byKey.openmeterPlanId} (same plan key, stale version)`,
      details: {
        subscriptionId: subscription.id,
        subscriptionPlanId: planId,
        localOpenmeterPlanId: byKey.openmeterPlanId,
        planKey,
        remoteVersion: remotePlan?.version,
      },
      remediation: FIX_MIGRATE,
    });
    return findings;
  }

  findings.push({
    code: "owner_subscription_unmapped_plan",
    severity: "error",
    ownerId,
    message:
      `Owner sub ${subscription.id} plan ${planId}` +
      (planKey ? ` (key=${planKey})` : "") +
      ` does not map to Owner Starter (${OWNER_STARTER_PLAN_KEY}) or any owned app Starter`,
    details: {
      subscriptionId: subscription.id,
      subscriptionPlanId: planId,
      planKey,
      ownedStarterPlanIds: ownedStarters.map((s) => s.openmeterPlanId),
      ownedStarterPlanKeys: ownedStarters.map((s) => s.planKey),
    },
    remediation: FIX_MIGRATE,
  });

  return findings;
}

/**
 * Detect mint/signer gate mismatch: unused included allowance but spendable=0.
 * Pure — no I/O.
 */
/**
 * Compare the subjects a customer is *attributed* against the subjects that
 * actually carry metered usage.
 *
 * OpenMeter invoices per customer over `usageAttribution.subjectKeys`. A
 * subject carrying usage that is not attributed to any customer is metered,
 * displayed, and **never billed** — a silent revenue leak that looks like
 * normal operation. The reverse (attributed but idle) is harmless.
 *
 * See docs/adr-owner-vs-app-billing.md ("Usage reads follow customer id").
 */
export function classifyUsageAttributionConsistency(input: {
  ownerId: string;
  customerKey: string;
  /** `usageAttribution.subjectKeys` from the OpenMeter customer record. */
  attributedSubjects: string[];
  /** Subjects observed carrying non-zero usage this cycle. */
  subjectsWithUsage: string[];
}): BillingConsistencyFinding[] {
  const attributed = new Set(
    input.attributedSubjects.map((key) => key.trim()).filter(Boolean),
  );
  const used = [
    ...new Set(input.subjectsWithUsage.map((key) => key.trim()).filter(Boolean)),
  ];

  if (attributed.size === 0) {
    return [
      {
        code: "customer_has_no_usage_attribution",
        severity: "error",
        ownerId: input.ownerId,
        message: `Customer ${input.customerKey} has no attributed subjects; OpenMeter cannot bill any of its usage.`,
        details: { customerKey: input.customerKey, subjectsWithUsage: used },
        remediation:
          "Re-run openmeter-migrate-owner-customers.ts to attach the settlement subject.",
      },
    ];
  }

  const unattributed = used.filter((subject) => !attributed.has(subject));
  if (unattributed.length === 0) {
    return [];
  }

  return [
    {
      code: "usage_on_unattributed_subject",
      severity: "error",
      ownerId: input.ownerId,
      message: `Customer ${input.customerKey} has usage on ${unattributed.length} subject(s) it is not attributed: ${unattributed.join(", ")}. This usage is metered but will never be invoiced.`,
      details: {
        customerKey: input.customerKey,
        unattributed,
        attributed: [...attributed],
      },
      remediation:
        "Attach the subject to the customer, or re-key ingest to the canonical customer subject. Until then PymtHouse shows usage the billing engine will not charge for.",
    },
  ];
}

export function classifySpendableGateConsistency(input: {
  ownerId: string;
  clientId: string;
  expectedIncludedUsdMicros: bigint;
  usedUsdMicros: bigint;
  creditBalanceUsdMicros: bigint;
  discountRemainingUsdMicros: bigint;
  spendableUsdMicros: bigint;
}): BillingConsistencyFinding[] {
  const findings: BillingConsistencyFinding[] = [];
  const {
    ownerId,
    clientId,
    expectedIncludedUsdMicros,
    usedUsdMicros,
    creditBalanceUsdMicros,
    discountRemainingUsdMicros,
    spendableUsdMicros,
  } = input;

  if (expectedIncludedUsdMicros <= 0n) {
    return findings;
  }

  const unusedIncluded = usedUsdMicros < expectedIncludedUsdMicros;
  if (
    unusedIncluded &&
    spendableUsdMicros <= 0n &&
    creditBalanceUsdMicros <= 0n
  ) {
    findings.push({
      code: "spendable_gate_blocks_with_unused_allowance",
      severity: "error",
      ownerId,
      clientId,
      message:
        `Spendable gate is 0 while cycle usage ${usedUsdMicros} < included ` +
        `${expectedIncludedUsdMicros} (discountRemaining=${discountRemainingUsdMicros}) — ` +
        `signer will return 483 Payment method required`,
      details: {
        usedUsdMicros: usedUsdMicros.toString(),
        expectedIncludedUsdMicros: expectedIncludedUsdMicros.toString(),
        creditBalanceUsdMicros: creditBalanceUsdMicros.toString(),
        discountRemainingUsdMicros: discountRemainingUsdMicros.toString(),
        spendableUsdMicros: spendableUsdMicros.toString(),
      },
      remediation: FIX_STARTER,
    });
  }

  if (
    creditBalanceUsdMicros + discountRemainingUsdMicros !== spendableUsdMicros
  ) {
    findings.push({
      code: "spendable_sum_mismatch",
      severity: "warn",
      ownerId,
      clientId,
      message: "spendable ≠ credits + discountRemaining",
      details: {
        creditBalanceUsdMicros: creditBalanceUsdMicros.toString(),
        discountRemainingUsdMicros: discountRemainingUsdMicros.toString(),
        spendableUsdMicros: spendableUsdMicros.toString(),
      },
    });
  }

  return findings;
}

export function summarizeFindings(findings: BillingConsistencyFinding[]): {
  errors: number;
  warns: number;
  infos: number;
} {
  let errors = 0;
  let warns = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.severity === "error") errors += 1;
    else if (f.severity === "warn") warns += 1;
    else infos += 1;
  }
  return { errors, warns, infos };
}

async function loadOwnedStarterPlans(
  ownerId: string,
): Promise<LocalStarterPlanRef[]> {
  const apps = await db
    .select({
      developerAppId: developerApps.id,
      publicClientId: oidcClients.clientId,
      appName: developerApps.name,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(developerApps.ownerId, ownerId));

  if (apps.length === 0) return [];

  const appIds = apps.map((a) => a.developerAppId);
  const starterRows = await db
    .select({
      id: plans.id,
      clientId: plans.clientId,
      includedUsdMicros: plans.includedUsdMicros,
      openmeterPlanId: plans.openmeterPlanId,
    })
    .from(plans)
    .where(
      and(
        inArray(plans.clientId, appIds),
        eq(plans.isStarterDefault, true),
        eq(plans.status, "active"),
      ),
    );

  const byApp = new Map(apps.map((a) => [a.developerAppId, a]));
  const out: LocalStarterPlanRef[] = [];
  for (const row of starterRows) {
    const app = byApp.get(row.clientId);
    if (!app) continue;
    const publicClientId = app.publicClientId?.trim() || app.developerAppId;
    out.push({
      planId: row.id,
      developerAppId: app.developerAppId,
      publicClientId,
      appName: app.appName,
      includedUsdMicros: row.includedUsdMicros,
      openmeterPlanId: row.openmeterPlanId,
      planKey: buildOpenMeterPlanKey(row.clientId, row.id),
    });
  }
  return out;
}

async function fetchRemotePlanSnapshot(
  client: OpenMeter,
  planId: string,
): Promise<RemotePlanSnapshot | null> {
  try {
    const plan = await client.plans.get(planId);
    if (!plan?.id) return null;
    return {
      id: plan.id,
      key: plan.key?.trim() || null,
      version: typeof plan.version === "number" ? plan.version : undefined,
      usageDiscountUsdMicros: readUsageDiscountUsdMicrosFromPlanBody(plan),
    };
  } catch {
    return null;
  }
}

async function queryOwnerUsedUsdMicros(
  ownerId: string,
  publicClientIds: string[],
): Promise<bigint> {
  if (!isHostedAdminClientAvailable()) return 0n;
  const client = getHostedAdminClient();
  const cycle = calendarMonthBoundsUtc(new Date());
  const subjects = buildOwnerMeterSubjects(ownerId, publicClientIds);
  try {
    const result = await client.meters.query(NETWORK_FEE_USD_MICROS_METER, {
      windowSize: "MONTH",
      from: new Date(cycle.start),
      to: new Date(cycle.end),
      subject: subjects,
    });
    let used = 0n;
    for (const row of result.data || []) {
      used += meterRowValueToBigInt(row.value);
    }
    return used;
  } catch {
    return 0n;
  }
}

/**
 * Which of `candidates` actually carried usage this cycle.
 *
 * Checks the whole set in one query first — the healthy case is "none", and
 * this keeps the audit to a single round-trip for it. Only when that total is
 * non-zero does it drill down per subject to name the offenders.
 */
async function findSubjectsWithUsage(
  client: OpenMeter,
  candidates: string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const cycle = calendarMonthBoundsUtc(new Date());
  const window = {
    windowSize: "MONTH" as const,
    from: new Date(cycle.start),
    to: new Date(cycle.end),
  };

  const totalFor = async (subjects: string[]): Promise<bigint> => {
    const result = await client.meters.query(NETWORK_FEE_USD_MICROS_METER, {
      ...window,
      subject: subjects,
    });
    let total = 0n;
    for (const row of result.data || []) {
      total += meterRowValueToBigInt(row.value);
    }
    return total;
  };

  try {
    if ((await totalFor(candidates)) === 0n) {
      return [];
    }
    const withUsage: string[] = [];
    for (const subject of candidates) {
      if ((await totalFor([subject])) > 0n) {
        withUsage.push(subject);
      }
    }
    return withUsage;
  } catch {
    // An audit that cannot read usage must not claim everything is attributed.
    return [];
  }
}

export type AuditBillingConsistencyOptions = {
  ownerId?: string;
  clientId?: string;
  /** Cap owners scanned when no filter is set (default 50). */
  limit?: number;
};

async function resolveOwnerIdForClientId(clientId: string): Promise<string | null> {
  const byPublic = await db
    .select({ ownerId: developerApps.ownerId })
    .from(developerApps)
    .innerJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(eq(oidcClients.clientId, clientId))
    .limit(1);
  if (byPublic[0]?.ownerId) return byPublic[0].ownerId;

  const byAppId = await db
    .select({ ownerId: developerApps.ownerId })
    .from(developerApps)
    .where(eq(developerApps.id, clientId))
    .limit(1);
  return byAppId[0]?.ownerId ?? null;
}

async function resolveOwnerIdsForAudit(
  options: AuditBillingConsistencyOptions,
): Promise<{ ownerIds: string[] } | { findings: BillingConsistencyFinding[] }> {
  if (options.ownerId?.trim()) {
    return { ownerIds: [options.ownerId.trim()] };
  }
  if (options.clientId?.trim()) {
    const clientId = options.clientId.trim();
    const ownerId = await resolveOwnerIdForClientId(clientId);
    if (!ownerId) {
      return {
        findings: [
          {
            code: "client_not_found",
            severity: "error",
            clientId,
            message: `No developer app for clientId=${clientId}`,
          },
        ],
      };
    }
    return { ownerIds: [ownerId] };
  }
  const limit = options.limit ?? 50;
  const rows = await db
    .selectDistinct({ ownerId: developerApps.ownerId })
    .from(developerApps)
    .innerJoin(users, eq(developerApps.ownerId, users.id))
    .limit(limit);
  return { ownerIds: rows.map((r) => r.ownerId).filter(Boolean) };
}

function matchesClientFilter(
  starter: LocalStarterPlanRef,
  clientIdFilter: string | undefined,
): boolean {
  if (!clientIdFilter?.trim()) return true;
  const filter = clientIdFilter.trim();
  return starter.publicClientId === filter || starter.developerAppId === filter;
}

async function auditOwnerStarterPlans(
  client: OpenMeter,
  starters: LocalStarterPlanRef[],
  clientIdFilter: string | undefined,
): Promise<BillingConsistencyFinding[]> {
  const findings: BillingConsistencyFinding[] = [];
  for (const starter of starters) {
    if (!matchesClientFilter(starter, clientIdFilter)) continue;
    const remote = starter.openmeterPlanId
      ? await fetchRemotePlanSnapshot(client, starter.openmeterPlanId)
      : null;
    findings.push(
      ...classifyStarterPlanRemoteConsistency({ local: starter, remote }),
    );
  }
  return findings;
}

async function auditOwnerSubscriptions(
  client: OpenMeter,
  ownerId: string,
  starters: LocalStarterPlanRef[],
): Promise<BillingConsistencyFinding[]> {
  const findings: BillingConsistencyFinding[] = [];
  const customerKey = buildOwnerCustomerKey(ownerId);

  let customerId: string;
  let attributedSubjects: string[] = [];
  try {
    const customer = (await findOpenMeterCustomerByKey(client, customerKey)) as
      | { id?: string; usageAttribution?: { subjectKeys?: string[] } }
      | null;
    attributedSubjects = [
      ...new Set(
        (customer?.usageAttribution?.subjectKeys ?? [])
          .map((key) => key.trim())
          .filter(Boolean),
      ),
    ];
    if (!customer?.id) {
      return [
        {
          code: "owner_customer_missing",
          severity: "error",
          ownerId,
          message: `No Konnect customer for bare key ${customerKey}`,
          details: { customerKey },
          remediation: FIX_MIGRATE,
        },
      ];
    }
    customerId = customer.id;
  } catch (err) {
    return [
      {
        code: "owner_customer_lookup_failed",
        severity: "error",
        ownerId,
        message:
          err instanceof Error ? err.message : "Failed to look up owner customer",
        details: { customerKey },
      },
    ];
  }

  const stripeCus = await getStripeCustomerAppDataId({ client, customerId });
  if (!stripeCus) {
    // Missing Stripe app data is only a defect for an owner who has something
    // chargeable. Owners without a payment method deliberately stay on the free
    // billing profile — Konnect rejects a Starter subscription for a customer
    // pinned to a Stripe profile with no default payment method — so
    // migrate-sandbox-to-stripe skips them by design. Reporting those as errors
    // pointed at a remediation that can never apply.
    // `null` (Stripe/OpenMeter unreachable) is treated as not-chargeable, the
    // same fail-open choice the migration makes.
    const chargeable = await ownerHasChargeablePaymentMethod(ownerId);
    if (chargeable === true) {
      findings.push({
        code: "owner_missing_stripe_app_data",
        severity: "error",
        ownerId,
        message: `Owner customer ${customerKey} has a payment method but no Stripe customer app data (cus_…)`,
        details: { customerId, customerKey },
        remediation: FIX_SANDBOX_TO_STRIPE,
      });
    }
  }

  if (
    shouldUseKonnectRoutes(getHostedOpenMeterUrl(), process.env.OPENMETER_API_KEY)
  ) {
    const profileId = await getKonnectCustomerBillingProfileId(customerId);
    const sandboxId = process.env.OPENMETER_FREE_BILLING_PROFILE_ID?.trim();
    if (profileId && sandboxId && profileId === sandboxId) {
      findings.push({
        code: "owner_sandbox_billing_profile",
        severity: "error",
        ownerId,
        message: `Owner customer ${customerKey} still uses sandbox billing profile ${profileId}`,
        details: { customerId, profileId },
        remediation: FIX_SANDBOX_TO_STRIPE,
      });
    }
  }

  const subs = await listOpenMeterSubscriptionsForCustomer(client, customerId);
  const active = subs.filter((s) => isOpenMeterSubscriptionActive(s.status));

  if (active.length === 0) {
    findings.push({
      code: "owner_no_active_subscription",
      severity: "error",
      ownerId,
      message: `No active subscription on ${customerKey}`,
      remediation: FIX_STARTER,
    });
  } else if (active.length > 1) {
    findings.push({
      code: "owner_multiple_active_subscriptions",
      severity: "warn",
      ownerId,
      message: `${active.length} active subscriptions on ${customerKey}`,
      details: { subscriptionIds: active.map((s) => s.id) },
      remediation: FIX_DEDUPE,
    });
  }

  for (const sub of active) {
    const remote = sub.planId
      ? await fetchRemotePlanSnapshot(client, sub.planId)
      : null;
    findings.push(
      ...classifyOwnerSubscriptionMapping({
        ownerId,
        subscription: {
          ...sub,
          planKey: sub.planKey ?? remote?.key ?? null,
        },
        remotePlan: remote,
        ownedStarters: starters,
      }),
    );
  }

  // Gate for the transitional-subject cutover: usage on a subject the customer
  // is not attributed is metered but never invoiced. This must report clean
  // before buildOwnerMeterSubjects can be reduced to the canonical key.
  // See docs/adr-owner-vs-app-billing.md.
  const ownedPublicClientIds = await listOwnedPublicClientIds(ownerId);
  const subjectsWithUsage = await findSubjectsWithUsage(
    client,
    buildOwnerMeterSubjects(ownerId, ownedPublicClientIds),
  );
  findings.push(
    ...classifyUsageAttributionConsistency({
      ownerId,
      customerKey,
      attributedSubjects,
      subjectsWithUsage,
    }),
  );

  return findings;
}

async function auditOwnerSpendableGates(input: {
  ownerId: string;
  starters: LocalStarterPlanRef[];
  options: AuditBillingConsistencyOptions;
}): Promise<BillingConsistencyFinding[]> {
  const { ownerId, starters, options } = input;
  const findings: BillingConsistencyFinding[] = [];
  const publicClientIds = await listOwnedPublicClientIds(ownerId);
  const used = await queryOwnerUsedUsdMicros(ownerId, publicClientIds);

  const scoped = Boolean(options.ownerId?.trim() || options.clientId?.trim());
  const spendableProbes = scoped ? starters : starters.slice(0, 1);

  for (const probe of spendableProbes) {
    if (!matchesClientFilter(probe, options.clientId)) continue;

    const expectedIncluded =
      parsePositiveMicros(ownerStarterIncludedUsdMicros()) ??
      includedDiscountUsdMicrosForPlan({
        includedUsdMicros: probe.includedUsdMicros,
        isStarterDefault: true,
      }) ??
      parsePositiveMicros(defaultStarterIncludedUsdMicros()) ??
      0n;

    const [credits, discountRemaining, spendable] = await Promise.all([
      getTrialCreditBalance({
        clientId: probe.publicClientId,
        externalUserId: ownerId,
      }),
      getRemainingPlanDiscountUsdMicros({
        clientId: probe.publicClientId,
        externalUserId: ownerId,
      }),
      getSpendableUsdMicros({
        clientId: probe.publicClientId,
        externalUserId: ownerId,
      }),
    ]);

    findings.push(
      ...classifySpendableGateConsistency({
        ownerId,
        clientId: probe.publicClientId,
        expectedIncludedUsdMicros: expectedIncluded,
        usedUsdMicros: used,
        creditBalanceUsdMicros: BigInt(credits?.balanceUsdMicros ?? "0"),
        discountRemainingUsdMicros: discountRemaining,
        spendableUsdMicros: BigInt(spendable ?? "0"),
      }),
    );
  }
  return findings;
}

/**
 * Active subscriptions remaining on a phase_out / deleted plan past phaseOutAt.
 * Pure — no I/O.
 */
export function classifyPhaseOutPastDeadline(input: {
  clientId: string;
  planId: string;
  planName: string;
  status: string;
  phaseOutAt: string | null;
  openmeterPlanId: string | null;
  activeSubscriberCount: number;
  nowIso?: string;
}): BillingConsistencyFinding[] {
  const findings: BillingConsistencyFinding[] = [];
  if (input.status !== "phase_out" && input.status !== "deleted") {
    return findings;
  }
  if (!input.phaseOutAt?.trim()) {
    return findings;
  }
  const deadline = Date.parse(input.phaseOutAt);
  if (Number.isNaN(deadline)) {
    return findings;
  }
  const now = Date.parse(input.nowIso ?? new Date().toISOString());
  if (now < deadline) {
    return findings;
  }
  if (input.activeSubscriberCount <= 0) {
    return findings;
  }

  findings.push({
    code: "phase_out_subscribers_past_deadline",
    severity: "error",
    clientId: input.clientId,
    message: `Plan "${input.planName}" is past phaseOutAt with ${input.activeSubscriberCount} active subscriber(s)`,
    details: {
      planId: input.planId,
      phaseOutAt: input.phaseOutAt,
      openmeterPlanId: input.openmeterPlanId,
      activeSubscriberCount: input.activeSubscriberCount,
    },
    remediation: FIX_MIGRATE_PLAN_SUBSCRIBERS,
  });
  return findings;
}

async function auditPhaseOutPlans(
  clientIdFilter?: string,
): Promise<BillingConsistencyFinding[]> {
  const findings: BillingConsistencyFinding[] = [];
  const rows = clientIdFilter?.trim()
    ? await db
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.clientId, clientIdFilter.trim()),
            eq(plans.status, "phase_out"),
          ),
        )
    : await db.select().from(plans).where(eq(plans.status, "phase_out"));

  for (const plan of rows) {
    if (!plan.phaseOutAt?.trim()) {
      continue;
    }
    const deadline = Date.parse(plan.phaseOutAt);
    if (Number.isNaN(deadline) || Date.now() < deadline) {
      continue;
    }
    let activeSubscriberCount = 0;
    if (plan.openmeterPlanId?.trim()) {
      try {
        activeSubscriberCount = await countActiveKonnectSubscriptionsForPlan(
          plan.openmeterPlanId,
        );
      } catch (err) {
        findings.push({
          code: "phase_out_subscriber_check_failed",
          severity: "warn",
          clientId: plan.clientId,
          message: `Unable to count subscribers for phase_out plan "${plan.name}"`,
          details: {
            planId: plan.id,
            error: err instanceof Error ? err.message : String(err),
          },
          remediation: FIX_MIGRATE_PLAN_SUBSCRIBERS,
        });
        continue;
      }
    }
    findings.push(
      ...classifyPhaseOutPastDeadline({
        clientId: plan.clientId,
        planId: plan.id,
        planName: plan.name,
        status: plan.status,
        phaseOutAt: plan.phaseOutAt,
        openmeterPlanId: plan.openmeterPlanId,
        activeSubscriberCount,
      }),
    );
  }
  return findings;
}

/**
 * Live audit: Neon Starter rows ↔ Konnect plans/subscriptions ↔ spendable gate.
 */
export async function auditBillingConsistency(
  options: AuditBillingConsistencyOptions = {},
): Promise<BillingConsistencyFinding[]> {
  if (!isHostedAdminClientAvailable()) {
    return [
      {
        code: "openmeter_unconfigured",
        severity: "error",
        message: "OPENMETER_URL / OPENMETER_API_KEY not configured",
      },
    ];
  }

  const resolved = await resolveOwnerIdsForAudit(options);
  if ("findings" in resolved) {
    return resolved.findings;
  }

  const client = getHostedAdminClient();
  const findings: BillingConsistencyFinding[] = [];

  for (const ownerId of resolved.ownerIds) {
    const starters = await loadOwnedStarterPlans(ownerId);
    if (starters.length === 0) {
      findings.push({
        code: "owner_no_starter_plans",
        severity: "warn",
        ownerId,
        message: "Owner has no active local Starter plans",
      });
    } else {
      findings.push(
        ...(await auditOwnerStarterPlans(client, starters, options.clientId)),
      );
    }

    // Owner Starter is platform-wide — still audit subscriptions when local
    // per-app Starter rows are missing.
    findings.push(
      ...(await auditOwnerSubscriptions(client, ownerId, starters)),
      ...(await auditOwnerSpendableGates({ ownerId, starters, options })),
    );
  }

  findings.push(...(await auditPhaseOutPlans(options.clientId)));

  return findings;
}
