/**
 * Scheduled BPP ⑥ usage-push orchestrator (the production caller for the
 * implemented-but-previously-uncalled `pushAppUsageToNaaP`).
 *
 * For a recent usage window this enumerates the provider's live apps, reads each
 * app's internal OpenMeter usage, and pushes the provider-NEUTRAL ⑥ payload to
 * NaaP (`POST {NAAP_METRICS_URL}/api/v1/metrics/ingest`) via
 * {@link pushAppUsageToNaaP}.
 *
 * Gated behind `USAGE_INGEST_PUSH` (default OFF). Flag-off is a STRICT no-op:
 * the job returns immediately without enumerating apps, reading usage, or making
 * any network call (see the first guard in {@link runUsageIngestPushJob}).
 */

import { inArray } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps } from "@/db/schema";
import { usageIngestPushEnabled } from "@/lib/billing/feature-flags";
import { pushAppUsageToNaaP, type PushUsageIngestResult } from "./usage-ingest";

const DEFAULT_PROVIDER_SLUG = "pymthouse";
const DEFAULT_WINDOW_HOURS = 24;

/** Developer-app statuses whose usage should be reported on the ⑥ seam. */
const PUSHABLE_APP_STATUSES = ["approved"] as const;

/** One app's ⑥ push target: the developer-app client id + its billing account. */
export interface UsagePushAccount {
  /** pymthouse developer-app client id (used as the ⑥ `appId`). */
  clientId: string;
  /**
   * Provider billing account of record (per D2: the OpenMeter
   * customer/subscription IS the billing account — there is no separate
   * billing-account entity, so the app's provider account is identified by its
   * client id). Kept as a distinct field so a finer-grained per-subscription
   * mapping can be layered in later without changing the caller contract.
   */
  accountId: string;
}

export interface RunUsageIngestPushJobInput {
  /** Lookback window size in hours (default `USAGE_INGEST_WINDOW_HOURS` or 24). */
  windowHours?: number;
  /** Provider slug stamped on every payload (default `pymthouse`). */
  providerSlug?: string;
  /** Correlation id propagated to NaaP as `x-request-id`. */
  correlationId?: string;
  /** Injectable account source; defaults to active developer apps from the DB. */
  listAccounts?: () => Promise<UsagePushAccount[]>;
  /** Injectable push fn (defaults to {@link pushAppUsageToNaaP}); for tests. */
  pushApp?: typeof pushAppUsageToNaaP;
  /** Injectable fetch passed through to the push (for tests). */
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic window computation (for tests). */
  now?: () => Date;
}

export interface UsagePushJobResult {
  /** Whether the `USAGE_INGEST_PUSH` flag was ON for this run. */
  enabled: boolean;
  /** Resolved usage window, or `null` when the job was a flag-off no-op. */
  window: { from: string; to: string } | null;
  /** Number of accounts the job attempted to push. */
  attempted: number;
  /** Count of pushes accepted by NaaP (`status: "ok"`). */
  pushed: number;
  skipped: number;
  disabled: number;
  errors: number;
  results: Array<{ clientId: string; status: PushUsageIngestResult["status"] }>;
}

function resolveWindowHours(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const fromEnv = Number(process.env.USAGE_INGEST_WINDOW_HOURS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_WINDOW_HOURS;
}

function recentWindow(windowHours: number, now: Date): { from: string; to: string } {
  const from = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

/** Active developer apps whose aggregate usage should be pushed on the ⑥ seam. */
export async function listActiveUsagePushAccounts(): Promise<UsagePushAccount[]> {
  const rows = await db
    .select({ clientId: developerApps.id })
    .from(developerApps)
    .where(inArray(developerApps.status, [...PUSHABLE_APP_STATUSES]));

  return rows.map((row) => ({ clientId: row.clientId, accountId: row.clientId }));
}

function emptyResult(enabled: boolean): UsagePushJobResult {
  return {
    enabled,
    window: null,
    attempted: 0,
    pushed: 0,
    skipped: 0,
    disabled: 0,
    errors: 0,
    results: [],
  };
}

/**
 * Run one ⑥ usage-push pass. Safe to invoke from a cron route or a billing-sync
 * hook. Flag-off (`USAGE_INGEST_PUSH` unset/false) is a strict no-op: it does
 * not enumerate apps, read OpenMeter, or make any network call.
 */
export async function runUsageIngestPushJob(
  input: RunUsageIngestPushJobInput = {},
): Promise<UsagePushJobResult> {
  if (!usageIngestPushEnabled()) {
    return emptyResult(false);
  }

  const now = (input.now ?? (() => new Date()))();
  const window = recentWindow(resolveWindowHours(input.windowHours), now);
  const listAccounts = input.listAccounts ?? listActiveUsagePushAccounts;
  const pushApp = input.pushApp ?? pushAppUsageToNaaP;
  const providerSlug = input.providerSlug ?? DEFAULT_PROVIDER_SLUG;

  const accounts = await listAccounts();
  const summary = emptyResult(true);
  summary.window = window;
  summary.attempted = accounts.length;

  for (const account of accounts) {
    const result = await pushApp({
      clientId: account.clientId,
      accountId: account.accountId,
      startDate: window.from,
      endDate: window.to,
      providerSlug,
      correlationId: input.correlationId,
      fetchImpl: input.fetchImpl,
    });

    summary.results.push({ clientId: account.clientId, status: result.status });
    switch (result.status) {
      case "ok":
        summary.pushed += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      case "disabled":
        summary.disabled += 1;
        break;
      case "error":
        summary.errors += 1;
        break;
    }
  }

  return summary;
}
