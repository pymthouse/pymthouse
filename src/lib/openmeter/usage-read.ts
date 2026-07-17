import {
  getOpenMeterClientForApp,
  getMeterSlugForApp,
} from "@/lib/openmeter/client-factory";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import {
  buildOpenMeterCustomerKey,
  buildOwnerMeterSubjects,
  buildOwnerWireSubject,
  normalizePlatformUserId,
} from "@/lib/openmeter/customer-key";
import {
  openMeterUsesLiveNetworkInTests,
  requireOpenMeterForUsageReads,
  SIGNED_TICKET_COUNT_METER,
} from "@/lib/openmeter/constants";
import type { MeterQueryRow } from "@openmeter/sdk";

function avoidOpenMeterNetworkInTests(): boolean {
  return process.env.NODE_ENV === "test" && !openMeterUsesLiveNetworkInTests();
}

/**
 * Parse an OpenMeter/Konnect meter row value to integer micros (or counts).
 * Prefers exact integer strings so small fee aggregates like `"34"` are not lost.
 */
export function meterRowValueToBigInt(value: unknown): bigint {
  if (value == null) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return 0n;
    if (/^-?\d+$/.test(t)) {
      try {
        return BigInt(t);
      } catch {
        return 0n;
      }
    }
    const parsed = Number(t);
    if (!Number.isFinite(parsed)) return 0n;
    return BigInt(Math.trunc(parsed));
  }
  return 0n;
}

function meterRowValueToCount(value: unknown): number {
  const n = Number(meterRowValueToBigInt(value));
  return Number.isFinite(n) ? n : 0;
}

export type OpenMeterUsageRow = {
  externalUserId: string;
  requestCount: number;
  networkFeeUsdMicros: string;
};

export type OpenMeterPipelineModelRow = {
  pipeline: string;
  modelId: string;
  requestCount: number;
  networkFeeUsdMicros: string;
};

export type OpenMeterUserPipelineModelRow = OpenMeterPipelineModelRow & {
  externalUserId: string;
};

export type OpenMeterDailyPipelineRow = {
  pipeline: string;
  modelId: string;
  date: string;
  requestCount: number;
  networkFeeUsdMicros: string;
};

export type OpenMeterAppDashboardUsage = {
  byUser: OpenMeterUsageRow[];
  byPipelineModel: OpenMeterPipelineModelRow[];
  byUserPipelineModel: OpenMeterUserPipelineModelRow[];
  byDailyPipeline: OpenMeterDailyPipelineRow[];
  requestsByDay: Map<string, number>;
};

type MeterWindowSize = "DAY" | "MONTH";

/** OpenMeter meter query dimensions (must match ingest event + meter groupBy). */
const METER_GROUP_BY_USER = ["client_id", "external_user_id"] as const;
const METER_GROUP_BY_DETAIL = [
  "client_id",
  "external_user_id",
  "pipeline",
  "model_id",
] as const;

/**
 * CloudEvent subjects to query for a filtered user. Owners dual-read bare /
 * `owner:` / compound transitional forms; end users keep the compound key
 * (plus harmless empty transitional subjects).
 */
export function buildUsageMeterSubjects(
  publicClientId: string,
  externalUserId: string,
): string[] {
  const trimmed = externalUserId.trim();
  if (!trimmed) return [];
  const clientId = publicClientId.trim();
  const normalized = normalizePlatformUserId(trimmed);
  return [
    ...new Set([
      ...buildOwnerMeterSubjects(normalized, clientId ? [clientId] : []),
      buildOpenMeterCustomerKey(clientId, trimmed),
      trimmed,
      buildOwnerWireSubject(normalized),
    ]),
  ];
}

/** Values that may appear in meter groupBy.external_user_id for a filter. */
export function buildExternalUserIdMatchKeys(externalUserId: string): Set<string> {
  const trimmed = externalUserId.trim();
  const keys = new Set<string>();
  if (!trimmed) return keys;
  const normalized = normalizePlatformUserId(trimmed);
  keys.add(trimmed);
  keys.add(normalized);
  keys.add(buildOwnerWireSubject(normalized));
  keys.add(`user:${normalized}`);
  return keys;
}

function matchesExternalUserFilter(
  groupExternalUserId: string,
  filter: string | null | undefined,
  matchKeys?: Set<string>,
): boolean {
  if (!filter?.trim()) return true;
  if (groupExternalUserId === filter) return true;
  if (matchKeys?.has(groupExternalUserId)) return true;
  return (
    normalizePlatformUserId(groupExternalUserId) === normalizePlatformUserId(filter)
  );
}

/**
 * When filtering to one user, collapse transitional groupBy external_user_id
 * variants onto the normalized filter id so dual-read rows merge.
 */
function canonicalizeFilteredExternalUserId(
  groupExternalUserId: string,
  filter: string | null | undefined,
  matchKeys?: Set<string>,
): string {
  if (
    filter?.trim() &&
    matchesExternalUserFilter(groupExternalUserId, filter, matchKeys)
  ) {
    return normalizePlatformUserId(filter);
  }
  return groupExternalUserId;
}

async function resolveUsageMeterSubjects(input: {
  clientId: string;
  externalUserId?: string | null;
}): Promise<string[] | undefined> {
  const externalUserId = input.externalUserId?.trim();
  if (!externalUserId) return undefined;

  try {
    const { resolveOpenMeterBillingIdentity } = await import(
      "@/lib/openmeter/billing-identity"
    );
    const identity = await resolveOpenMeterBillingIdentity({
      clientId: input.clientId,
      externalUserId,
    });
    if (identity.isOwner && identity.ownerUserId) {
      return buildOwnerMeterSubjects(identity.ownerUserId, [
        identity.publicClientId,
      ]);
    }
    return [identity.customerKey];
  } catch {
    return buildUsageMeterSubjects(input.clientId, externalUserId);
  }
}

function buildMeterQuery(input: {
  startDate?: string | null;
  endDate?: string | null;
  windowSize: MeterWindowSize;
  clientId: string;
  /** Pre-resolved CloudEvent subjects (owner dual-read or compound end-user). */
  subjects?: string[] | null;
  groupBy: readonly string[];
}): Record<string, unknown> {
  const query: Record<string, unknown> = {
    windowSize: input.windowSize,
    groupBy: [...input.groupBy],
    // Konnect maps SDK `clientId` → filters.dimensions.client_id (see buildKonnectMeterQueryBody).
    // Without this, queries scan the entire shared meter and commonly 504 under load.
    clientId: input.clientId,
  };
  if (input.startDate) {
    query.from = new Date(input.startDate);
  }
  if (input.endDate) {
    query.to = new Date(input.endDate);
  }
  if (input.subjects && input.subjects.length > 0) {
    query.subject = input.subjects;
  }
  return query;
}

function groupByString(
  group: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = group[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function clientIdFromGroup(
  group: Record<string, unknown>,
  fallbackClientId: string,
): string {
  return groupByString(group, "client_id", fallbackClientId);
}

/** UTC date key (YYYY-MM-DD) from an OpenMeter meter query row window. */
export function dateKeyFromMeterWindow(row: Pick<MeterQueryRow, "windowStart">): string | null {
  const windowStart = row.windowStart;
  if (!windowStart) {
    return null;
  }
  const date = windowStart instanceof Date ? windowStart : new Date(windowStart);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function aggregateUserRows(input: {
  clientId: string;
  feeRows: MeterQueryRow[];
  countRows: MeterQueryRow[];
  filterExternalUserId?: string | null;
}): OpenMeterUsageRow[] {
  const matchKeys = input.filterExternalUserId
    ? buildExternalUserIdMatchKeys(input.filterExternalUserId)
    : undefined;

  const acceptRow = (group: Record<string, unknown>): string | null => {
    const rawExternalUserId = groupByString(group, "external_user_id", "");
    if (!rawExternalUserId) return null;
    if (
      !matchesExternalUserFilter(
        rawExternalUserId,
        input.filterExternalUserId,
        matchKeys,
      )
    ) {
      return null;
    }
    if (clientIdFromGroup(group, input.clientId) !== input.clientId) return null;
    return canonicalizeFilteredExternalUserId(
      rawExternalUserId,
      input.filterExternalUserId,
      matchKeys,
    );
  };

  const countByUser = new Map<string, number>();
  for (const row of input.countRows) {
    const externalUserId = acceptRow((row.groupBy || {}) as Record<string, unknown>);
    if (!externalUserId) continue;
    countByUser.set(
      externalUserId,
      (countByUser.get(externalUserId) ?? 0) + meterRowValueToCount(row.value),
    );
  }

  const feeByUser = new Map<string, bigint>();
  for (const row of input.feeRows) {
    const externalUserId = acceptRow((row.groupBy || {}) as Record<string, unknown>);
    if (!externalUserId) continue;
    feeByUser.set(
      externalUserId,
      (feeByUser.get(externalUserId) ?? 0n) + meterRowValueToBigInt(row.value),
    );
  }

  const externalUserIds = new Set([...countByUser.keys(), ...feeByUser.keys()]);
  const rows: OpenMeterUsageRow[] = [...externalUserIds].map((externalUserId) => ({
    externalUserId,
    requestCount: countByUser.get(externalUserId) ?? 0,
    networkFeeUsdMicros: (feeByUser.get(externalUserId) ?? 0n).toString(),
  }));

  if (rows.length === 0 && input.filterExternalUserId) {
    const canonical = normalizePlatformUserId(input.filterExternalUserId);
    rows.push({
      externalUserId: canonical,
      requestCount: countByUser.get(canonical) ?? 0,
      networkFeeUsdMicros: "0",
    });
  }

  return rows;
}

export function aggregatePipelineModelRows(input: {
  clientId: string;
  feeRows: MeterQueryRow[];
  countRows: MeterQueryRow[];
}): OpenMeterPipelineModelRow[] {
  const countByKey = new Map<string, number>();
  const metaByKey = new Map<string, { pipeline: string; modelId: string }>();

  for (const row of input.countRows) {
    const group = (row.groupBy || {}) as Record<string, unknown>;
    if (clientIdFromGroup(group, input.clientId) !== input.clientId) continue;
    const pipeline = groupByString(group, "pipeline", "unknown");
    const modelId = groupByString(group, "model_id", "unknown");
    const key = `${pipeline}|${modelId}`;
    metaByKey.set(key, { pipeline, modelId });
    countByKey.set(
      key,
      (countByKey.get(key) ?? 0) + meterRowValueToCount(row.value),
    );
  }

  const feeByKey = new Map<string, bigint>();
  for (const row of input.feeRows) {
    const group = (row.groupBy || {}) as Record<string, unknown>;
    if (clientIdFromGroup(group, input.clientId) !== input.clientId) continue;
    const pipeline = groupByString(group, "pipeline", "unknown");
    const modelId = groupByString(group, "model_id", "unknown");
    const key = `${pipeline}|${modelId}`;
    metaByKey.set(key, { pipeline, modelId });
    feeByKey.set(
      key,
      (feeByKey.get(key) ?? 0n) + meterRowValueToBigInt(row.value),
    );
  }

  const keys = new Set([...countByKey.keys(), ...feeByKey.keys()]);
  return [...keys].flatMap((key) => {
    const meta = metaByKey.get(key);
    if (!meta) {
      return [];
    }
    return [
      {
        pipeline: meta.pipeline,
        modelId: meta.modelId,
        requestCount: countByKey.get(key) ?? 0,
        networkFeeUsdMicros: (feeByKey.get(key) ?? 0n).toString(),
      },
    ];
  });
}

type UserPipelineModelMeta = {
  externalUserId: string;
  pipeline: string;
  modelId: string;
  key: string;
};

function resolveUserPipelineModelMeta(
  row: MeterQueryRow,
  clientId: string,
  filterExternalUserId?: string | null,
  matchKeys?: Set<string>,
): UserPipelineModelMeta | null {
  const group = (row.groupBy || {}) as Record<string, unknown>;
  if (clientIdFromGroup(group, clientId) !== clientId) return null;
  const rawExternalUserId = groupByString(group, "external_user_id", "");
  if (!rawExternalUserId) return null;
  if (
    !matchesExternalUserFilter(rawExternalUserId, filterExternalUserId, matchKeys)
  ) {
    return null;
  }
  const externalUserId = canonicalizeFilteredExternalUserId(
    rawExternalUserId,
    filterExternalUserId,
    matchKeys,
  );
  const pipeline = groupByString(group, "pipeline", "unknown");
  const modelId = groupByString(group, "model_id", "unknown");
  return {
    externalUserId,
    pipeline,
    modelId,
    key: `${externalUserId}|${pipeline}|${modelId}`,
  };
}

export function aggregateUserPipelineModelRows(input: {
  clientId: string;
  feeRows: MeterQueryRow[];
  countRows: MeterQueryRow[];
  filterExternalUserId?: string | null;
}): OpenMeterUserPipelineModelRow[] {
  const matchKeys = input.filterExternalUserId
    ? buildExternalUserIdMatchKeys(input.filterExternalUserId)
    : undefined;
  const countByKey = new Map<string, number>();
  const metaByKey = new Map<
    string,
    { externalUserId: string; pipeline: string; modelId: string }
  >();

  for (const row of input.countRows) {
    const meta = resolveUserPipelineModelMeta(
      row,
      input.clientId,
      input.filterExternalUserId,
      matchKeys,
    );
    if (!meta) continue;
    metaByKey.set(meta.key, {
      externalUserId: meta.externalUserId,
      pipeline: meta.pipeline,
      modelId: meta.modelId,
    });
    countByKey.set(
      meta.key,
      (countByKey.get(meta.key) ?? 0) + meterRowValueToCount(row.value),
    );
  }

  const feeByKey = new Map<string, bigint>();
  for (const row of input.feeRows) {
    const meta = resolveUserPipelineModelMeta(
      row,
      input.clientId,
      input.filterExternalUserId,
      matchKeys,
    );
    if (!meta) continue;
    metaByKey.set(meta.key, {
      externalUserId: meta.externalUserId,
      pipeline: meta.pipeline,
      modelId: meta.modelId,
    });
    feeByKey.set(
      meta.key,
      (feeByKey.get(meta.key) ?? 0n) + meterRowValueToBigInt(row.value),
    );
  }

  const keys = new Set([...countByKey.keys(), ...feeByKey.keys()]);
  return [...keys].flatMap((key) => {
    const meta = metaByKey.get(key);
    if (!meta) {
      return [];
    }
    return [
      {
        externalUserId: meta.externalUserId,
        pipeline: meta.pipeline,
        modelId: meta.modelId,
        requestCount: countByKey.get(key) ?? 0,
        networkFeeUsdMicros: (feeByKey.get(key) ?? 0n).toString(),
      },
    ];
  });
}

export function aggregateDailyPipelineModelRows(input: {
  clientId: string;
  feeRows: MeterQueryRow[];
  countRows: MeterQueryRow[];
}): OpenMeterDailyPipelineRow[] {
  const byKey = new Map<
    string,
    {
      pipeline: string;
      modelId: string;
      date: string;
      requestCount: number;
      networkFeeUsdMicros: bigint;
    }
  >();

  for (const row of input.countRows) {
    const group = (row.groupBy || {}) as Record<string, unknown>;
    if (clientIdFromGroup(group, input.clientId) !== input.clientId) continue;
    const pipeline = groupByString(group, "pipeline", "unknown");
    const modelId = groupByString(group, "model_id", "unknown");
    const day = dateKeyFromMeterWindow(row);
    if (!day) continue;
    const key = `${pipeline}|${modelId}|${day}`;
    const existing = byKey.get(key) ?? {
      pipeline,
      modelId,
      date: day,
      requestCount: 0,
      networkFeeUsdMicros: 0n,
    };
    existing.requestCount += meterRowValueToCount(row.value);
    byKey.set(key, existing);
  }

  for (const row of input.feeRows) {
    const group = (row.groupBy || {}) as Record<string, unknown>;
    if (clientIdFromGroup(group, input.clientId) !== input.clientId) continue;
    const pipeline = groupByString(group, "pipeline", "unknown");
    const modelId = groupByString(group, "model_id", "unknown");
    const day = dateKeyFromMeterWindow(row);
    if (!day) continue;
    const key = `${pipeline}|${modelId}|${day}`;
    const existing = byKey.get(key) ?? {
      pipeline,
      modelId,
      date: day,
      requestCount: 0,
      networkFeeUsdMicros: 0n,
    };
    existing.networkFeeUsdMicros += meterRowValueToBigInt(row.value);
    byKey.set(key, existing);
  }

  return [...byKey.values()]
    .map((row) => ({
      pipeline: row.pipeline,
      modelId: row.modelId,
      date: row.date,
      requestCount: row.requestCount,
      networkFeeUsdMicros: row.networkFeeUsdMicros.toString(),
    }))
    .sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date);
      if (dateCmp !== 0) return dateCmp;
      const pipelineCmp = a.pipeline.localeCompare(b.pipeline);
      if (pipelineCmp !== 0) return pipelineCmp;
      return a.modelId.localeCompare(b.modelId);
    });
}

export function aggregateDailyRequestCounts(input: {
  clientId: string;
  countRows: MeterQueryRow[];
}): Map<string, number> {
  const requestsByDay = new Map<string, number>();
  for (const row of input.countRows) {
    const group = (row.groupBy || {}) as Record<string, unknown>;
    if (clientIdFromGroup(group, input.clientId) !== input.clientId) continue;
    const day = dateKeyFromMeterWindow(row);
    if (!day) continue;
    requestsByDay.set(
      day,
      (requestsByDay.get(day) ?? 0) + meterRowValueToCount(row.value),
    );
  }
  return requestsByDay;
}

const testUsageRowsByClient = new Map<string, OpenMeterUsageRow[]>();
const testDashboardByClient = new Map<string, OpenMeterAppDashboardUsage>();
const testIngestLogByClient = new Map<
  string,
  Array<{
    externalUserId: string;
    networkFeeUsdMicros: bigint;
    pipeline: string;
    modelId: string;
    ingestedAtMs: number;
  }>
>();
const testUsagePeriodByClient = new Map<string, { oldestMs: number; newestMs: number }>();

/** Accumulate signed-ticket ingest into in-memory meter stubs (NODE_ENV=test only). */
export function __testAccumulateOpenMeterUsage(input: {
  clientId: string;
  externalUserId: string;
  networkFeeUsdMicros: string;
  pipeline?: string;
  modelId?: string;
}): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__testAccumulateOpenMeterUsage is only available in test");
  }

  const fee = BigInt(input.networkFeeUsdMicros || "0");
  if (fee <= 0n) {
    return;
  }

  const pipeline = input.pipeline?.trim() || "unknown";
  const modelId = input.modelId?.trim() || "unknown";
  const rows = testUsageRowsByClient.get(input.clientId) ?? [];
  const existing = rows.find((row) => row.externalUserId === input.externalUserId);
  if (existing) {
    existing.requestCount += 1;
    existing.networkFeeUsdMicros = (
      BigInt(existing.networkFeeUsdMicros) + fee
    ).toString();
  } else {
    rows.push({
      externalUserId: input.externalUserId,
      requestCount: 1,
      networkFeeUsdMicros: fee.toString(),
    });
  }
  testUsageRowsByClient.set(input.clientId, rows);

  const ingestedAtMs = Date.now();
  const log = testIngestLogByClient.get(input.clientId) ?? [];
  log.push({
    externalUserId: input.externalUserId,
    networkFeeUsdMicros: fee,
    pipeline,
    modelId,
    ingestedAtMs,
  });
  testIngestLogByClient.set(input.clientId, log);

  const period = testUsagePeriodByClient.get(input.clientId);
  if (period) {
    period.oldestMs = Math.min(period.oldestMs, ingestedAtMs);
    period.newestMs = Math.max(period.newestMs, ingestedAtMs);
  } else {
    testUsagePeriodByClient.set(input.clientId, {
      oldestMs: ingestedAtMs,
      newestMs: ingestedAtMs,
    });
  }
}

function testStubOverlapsQueryWindow(input: {
  clientId: string;
  startDate?: string | null;
  endDate?: string | null;
}): boolean {
  if (!input.startDate && !input.endDate) {
    return true;
  }
  const period = testUsagePeriodByClient.get(input.clientId);
  if (!period) {
    return false;
  }
  const startMs = input.startDate ? Date.parse(input.startDate) : Number.NEGATIVE_INFINITY;
  const endMs = input.endDate ? Date.parse(input.endDate) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return true;
  }
  return period.newestMs >= startMs && period.oldestMs <= endMs;
}

function aggregateTestPipelineRowsForUser(input: {
  clientId: string;
  externalUserId: string;
}): OpenMeterPipelineModelRow[] {
  const log = testIngestLogByClient.get(input.clientId) ?? [];
  const byKey = new Map<string, OpenMeterPipelineModelRow>();
  for (const event of log) {
    if (event.externalUserId !== input.externalUserId) {
      continue;
    }
    const key = `${event.pipeline}|${event.modelId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.requestCount += 1;
      existing.networkFeeUsdMicros = (
        BigInt(existing.networkFeeUsdMicros) + event.networkFeeUsdMicros
      ).toString();
    } else {
      byKey.set(key, {
        pipeline: event.pipeline,
        modelId: event.modelId,
        requestCount: 1,
        networkFeeUsdMicros: event.networkFeeUsdMicros.toString(),
      });
    }
  }
  return [...byKey.values()];
}

function aggregateDailyRowsToPipelineModel(
  daily: OpenMeterDailyPipelineRow[],
): OpenMeterPipelineModelRow[] {
  const byKey = new Map<string, OpenMeterPipelineModelRow>();
  for (const row of daily) {
    const key = `${row.pipeline}|${row.modelId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.requestCount += row.requestCount;
      existing.networkFeeUsdMicros = (
        BigInt(existing.networkFeeUsdMicros) + BigInt(row.networkFeeUsdMicros)
      ).toString();
    } else {
      byKey.set(key, {
        pipeline: row.pipeline,
        modelId: row.modelId,
        requestCount: row.requestCount,
        networkFeeUsdMicros: row.networkFeeUsdMicros,
      });
    }
  }
  return [...byKey.values()];
}

/** Test stubs for per-user pipeline/model rows; undefined means use live OpenMeter. */
function getTestPipelineModelRows(input: {
  clientId: string;
  externalUserId: string;
}): OpenMeterPipelineModelRow[] | undefined {
  const fromIngest = aggregateTestPipelineRowsForUser(input);
  if (fromIngest.length > 0) {
    return fromIngest;
  }
  const daily = testDailyByClient.get(input.clientId);
  if (!daily) {
    return undefined;
  }
  return aggregateDailyRowsToPipelineModel(daily);
}

/** Register OpenMeter meter rows for integration tests (NODE_ENV=test only). */
export function __testSetOpenMeterUsageRows(
  clientId: string,
  rows: OpenMeterUsageRow[],
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__testSetOpenMeterUsageRows is only available in test");
  }
  testUsageRowsByClient.set(clientId, rows);
}

export function __testSetOpenMeterDashboardUsage(
  clientId: string,
  dashboard: OpenMeterAppDashboardUsage,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__testSetOpenMeterDashboardUsage is only available in test");
  }
  testDashboardByClient.set(clientId, dashboard);
}

export function __testClearOpenMeterUsageStubs(): void {
  testUsageRowsByClient.clear();
  testDashboardByClient.clear();
  testDailyByClient.clear();
  testIngestLogByClient.clear();
  testUsagePeriodByClient.clear();
}

function filterTestUsageRows(
  rows: OpenMeterUsageRow[],
  input: { externalUserId?: string | null },
): OpenMeterUsageRow[] {
  if (!input.externalUserId) {
    return rows;
  }
  const matchKeys = buildExternalUserIdMatchKeys(input.externalUserId);
  return rows.filter((row) =>
    matchesExternalUserFilter(row.externalUserId, input.externalUserId, matchKeys),
  );
}

/** Per-user period totals by pipeline/model (OpenMeter MONTH windows, subject-scoped). */
export async function queryOpenMeterUserPipelineByModel(input: {
  clientId: string;
  startDate?: string | null;
  endDate?: string | null;
  externalUserId: string;
}): Promise<OpenMeterPipelineModelRow[]> {
  if (!requireOpenMeterForUsageReads()) {
    return [];
  }

  if (process.env.NODE_ENV === "test") {
    const stub = getTestPipelineModelRows({
      clientId: input.clientId,
      externalUserId: input.externalUserId,
    });
    if (stub !== undefined) {
      return stub;
    }
  }

  if (avoidOpenMeterNetworkInTests()) {
    return [];
  }

  const meterClientId = await resolveOpenMeterMeterClientId(input.clientId);
  const client = await getOpenMeterClientForApp(input.clientId);
  if (!client) {
    return [];
  }

  const meterSlug = await getMeterSlugForApp(input.clientId);
  const subjects = await resolveUsageMeterSubjects({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const periodQuery = buildMeterQuery({
    clientId: meterClientId,
    startDate: input.startDate,
    endDate: input.endDate,
    windowSize: "MONTH",
    subjects,
    groupBy: METER_GROUP_BY_DETAIL,
  });

  const [feeResult, countResult] = await Promise.all([
    client.meters.query(meterSlug, periodQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, periodQuery),
  ]);

  return aggregatePipelineModelRows({
    clientId: meterClientId,
    feeRows: feeResult.data || [],
    countRows: countResult.data || [],
  });
}

/** Per-user daily signed-ticket counts and network fees by pipeline/model (OpenMeter DAY windows). */
export async function queryOpenMeterUserDailyByPipeline(input: {
  clientId: string;
  startDate?: string | null;
  endDate?: string | null;
  externalUserId: string;
}): Promise<OpenMeterDailyPipelineRow[]> {
  if (!requireOpenMeterForUsageReads()) {
    return [];
  }

  if (process.env.NODE_ENV === "test") {
    const stub = testDailyByClient.get(input.clientId);
    if (stub) {
      return stub;
    }
  }

  if (avoidOpenMeterNetworkInTests()) {
    return [];
  }

  const meterClientId = await resolveOpenMeterMeterClientId(input.clientId);
  const client = await getOpenMeterClientForApp(input.clientId);
  if (!client) {
    return [];
  }

  const meterSlug = await getMeterSlugForApp(input.clientId);
  const subjects = await resolveUsageMeterSubjects({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const dayQuery = buildMeterQuery({
    clientId: meterClientId,
    startDate: input.startDate,
    endDate: input.endDate,
    windowSize: "DAY",
    subjects,
    groupBy: METER_GROUP_BY_DETAIL,
  });

  const [feeResult, countResult] = await Promise.all([
    client.meters.query(meterSlug, dayQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, dayQuery),
  ]);

  return aggregateDailyPipelineModelRows({
    clientId: meterClientId,
    feeRows: feeResult.data || [],
    countRows: countResult.data || [],
  });
}

const testDailyByClient = new Map<string, OpenMeterDailyPipelineRow[]>();

export function __testSetOpenMeterDailyPipelineRows(
  clientId: string,
  rows: OpenMeterDailyPipelineRow[],
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__testSetOpenMeterDailyPipelineRows is only available in test");
  }
  testDailyByClient.set(clientId, rows);
}

export async function queryOpenMeterUsage(input: {
  clientId: string;
  startDate?: string | null;
  endDate?: string | null;
  externalUserId?: string | null;
}): Promise<OpenMeterUsageRow[]> {
  if (!requireOpenMeterForUsageReads()) {
    return [];
  }

  if (process.env.NODE_ENV === "test") {
    const stub = testUsageRowsByClient.get(input.clientId);
    if (stub && testStubOverlapsQueryWindow(input)) {
      return filterTestUsageRows(stub, input);
    }
    if (stub) {
      return [];
    }
  }

  if (avoidOpenMeterNetworkInTests()) {
    return [];
  }

  const meterClientId = await resolveOpenMeterMeterClientId(input.clientId);
  const client = await getOpenMeterClientForApp(input.clientId);
  if (!client) {
    return [];
  }

  const meterSlug = await getMeterSlugForApp(input.clientId);
  const subjects = await resolveUsageMeterSubjects({
    clientId: input.clientId,
    externalUserId: input.externalUserId,
  });
  const periodQuery = buildMeterQuery({
    clientId: meterClientId,
    startDate: input.startDate,
    endDate: input.endDate,
    windowSize: "MONTH",
    subjects,
    groupBy: METER_GROUP_BY_USER,
  });

  const [feeResult, countResult] = await Promise.all([
    client.meters.query(meterSlug, periodQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, periodQuery),
  ]);

  return aggregateUserRows({
    clientId: meterClientId,
    feeRows: feeResult.data || [],
    countRows: countResult.data || [],
    filterExternalUserId: input.externalUserId,
  });
}

/** Per-app usage for the platform billing dashboard (users, pipeline/model, daily chart). */
export async function queryOpenMeterAppDashboardUsage(input: {
  clientId: string;
  startDate?: string | null;
  endDate?: string | null;
}): Promise<OpenMeterAppDashboardUsage | null> {
  if (!requireOpenMeterForUsageReads()) {
    return null;
  }

  if (process.env.NODE_ENV === "test") {
    const stub = testDashboardByClient.get(input.clientId);
    if (stub) {
      return stub;
    }
  }

  if (avoidOpenMeterNetworkInTests()) {
    return null;
  }

  const meterClientId = await resolveOpenMeterMeterClientId(input.clientId);
  const client = await getOpenMeterClientForApp(input.clientId);
  if (!client) {
    return null;
  }

  const meterSlug = await getMeterSlugForApp(input.clientId);
  const periodQuery = buildMeterQuery({
    clientId: meterClientId,
    startDate: input.startDate,
    endDate: input.endDate,
    windowSize: "MONTH",
    groupBy: METER_GROUP_BY_DETAIL,
  });
  const dayQuery = buildMeterQuery({
    clientId: meterClientId,
    startDate: input.startDate,
    endDate: input.endDate,
    windowSize: "DAY",
    groupBy: METER_GROUP_BY_DETAIL,
  });

  const [feeResult, countResult, dayFeeResult, dayCountResult] = await Promise.all([
    client.meters.query(meterSlug, periodQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, periodQuery),
    client.meters.query(meterSlug, dayQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, dayQuery),
  ]);

  const feeRows = feeResult.data || [];
  const countRows = countResult.data || [];

  const dayCountRows = dayCountResult.data || [];

  return {
    byUser: aggregateUserRows({
      clientId: meterClientId,
      feeRows,
      countRows,
    }),
    byPipelineModel: aggregatePipelineModelRows({
      clientId: meterClientId,
      feeRows,
      countRows,
    }),
    byUserPipelineModel: aggregateUserPipelineModelRows({
      clientId: meterClientId,
      feeRows,
      countRows,
    }),
    byDailyPipeline: aggregateDailyPipelineModelRows({
      clientId: meterClientId,
      feeRows: dayFeeResult.data || [],
      countRows: dayCountRows,
    }),
    requestsByDay: aggregateDailyRequestCounts({
      clientId: meterClientId,
      countRows: dayCountRows,
    }),
  };
}

export function shouldReadUsageFromOpenMeter(): boolean {
  return requireOpenMeterForUsageReads();
}

function mapOpenMeterUserRows(input: {
  rows: OpenMeterUsageRow[];
  usageCurrency: string;
  includeRetail?: boolean;
  retailByPipelineModel?: Map<string, { endUserBillableUsdMicros: string; retailRateUsd: string }>;
}) {
  return input.rows.map((row) => {
    const base = {
      endUserId: row.externalUserId,
      externalUserId: row.externalUserId,
      userType: "system_managed" as const,
      identifier: row.externalUserId,
      currency: input.usageCurrency,
      networkFeeUsdMicros: row.networkFeeUsdMicros,
      ownerChargeUsdMicros: row.networkFeeUsdMicros,
      requestCount: row.requestCount,
    };
    if (input.includeRetail && input.retailByPipelineModel) {
      const retail = input.retailByPipelineModel.get("*|*");
      if (retail) {
        return { ...base, endUserBillableUsdMicros: retail.endUserBillableUsdMicros };
      }
    }
    return base;
  });
}

function mapOpenMeterPipelineModelRows(input: {
  pipelineRows: OpenMeterPipelineModelRow[];
  usageCurrency: string;
  includeRetail?: boolean;
  retailByPipelineModel?: Map<string, { endUserBillableUsdMicros: string; retailRateUsd: string }>;
}) {
  return input.pipelineRows.map((row) => {
    const key = `${row.pipeline}|${row.modelId}`;
    const retail = input.retailByPipelineModel?.get(key);
    const base = {
      pipeline: row.pipeline,
      modelId: row.modelId,
      currency: input.usageCurrency,
      requestCount: row.requestCount,
      networkFeeUsdMicros: row.networkFeeUsdMicros,
      ownerChargeUsdMicros: row.networkFeeUsdMicros,
    };
    if (input.includeRetail && retail) {
      return {
        ...base,
        retailRateUsd: retail.retailRateUsd,
        endUserBillableUsdMicros: retail.endUserBillableUsdMicros,
      };
    }
    return base;
  });
}

function sumRetailBillableUsdMicros(
  pipelineRows: OpenMeterPipelineModelRow[],
  retailByPipelineModel: Map<string, { endUserBillableUsdMicros: string; retailRateUsd: string }>,
): bigint {
  let totalRetail = 0n;
  for (const row of pipelineRows) {
    const key = `${row.pipeline}|${row.modelId}`;
    const retail = retailByPipelineModel.get(key);
    if (retail) {
      totalRetail += BigInt(retail.endUserBillableUsdMicros);
    }
  }
  return totalRetail;
}

/**
 * Build Builder API usage response from OpenMeter meter rows.
 * Retail (`endUserBillableUsdMicros`) is omitted until OM plan invoicing is queried;
 * network cost is authoritative from the signer-backed meter.
 */
export function buildOpenMeterUsageResponse(input: {
  clientId: string;
  startDate?: string | null;
  endDate?: string | null;
  groupBy: string;
  filterUserId?: string | null;
  rows: OpenMeterUsageRow[];
  pipelineRows?: OpenMeterPipelineModelRow[];
  dailyPipelineRows?: OpenMeterDailyPipelineRow[];
  includeRetail?: boolean;
  retailByPipelineModel?: Map<
    string,
    { endUserBillableUsdMicros: string; retailRateUsd: string }
  >;
}): Record<string, unknown> {
  const usageCurrency = "USD";
  let totalNetworkFeeUsdMicros = 0n;
  let totalRequestCount = 0;

  for (const row of input.rows) {
    totalNetworkFeeUsdMicros += BigInt(row.networkFeeUsdMicros);
    totalRequestCount += row.requestCount;
  }

  const response: Record<string, unknown> = {
    clientId: input.clientId,
    source: "openmeter",
    period: { start: input.startDate || null, end: input.endDate || null },
    totals: {
      requestCount: totalRequestCount,
      currency: usageCurrency,
      networkFeeUsdMicros: totalNetworkFeeUsdMicros.toString(),
      ownerChargeUsdMicros: totalNetworkFeeUsdMicros.toString(),
      platformFeeUsdMicros: "0",
    },
  };

  if (input.groupBy === "user") {
    response.byUser = mapOpenMeterUserRows({
      rows: input.rows,
      usageCurrency,
      includeRetail: input.includeRetail,
      retailByPipelineModel: input.retailByPipelineModel,
    });
  }

  if (input.groupBy === "daily_pipeline" && input.dailyPipelineRows) {
    response.byDailyPipeline = input.dailyPipelineRows.map((row) => ({
      pipeline: row.pipeline,
      modelId: row.modelId,
      date: row.date,
      requestCount: row.requestCount,
      currency: usageCurrency,
      networkFeeUsdMicros: row.networkFeeUsdMicros,
      ownerChargeUsdMicros: row.networkFeeUsdMicros,
    }));
  }

  if (input.groupBy === "pipeline_model" && input.pipelineRows) {
    response.byPipelineModel = mapOpenMeterPipelineModelRows({
      pipelineRows: input.pipelineRows,
      usageCurrency,
      includeRetail: input.includeRetail,
      retailByPipelineModel: input.retailByPipelineModel,
    });
    if (input.includeRetail && input.retailByPipelineModel) {
      const totalRetail = sumRetailBillableUsdMicros(
        input.pipelineRows,
        input.retailByPipelineModel,
      );
      (response.totals as Record<string, unknown>).endUserBillableUsdMicros =
        totalRetail.toString();
    }
  }

  return response;
}
