import {
  getOpenMeterClientForApp,
} from "@/lib/openmeter/client-factory";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { buildOpenMeterCustomerKey } from "@/lib/openmeter/customer-key";
import {
  getNetworkFeeNanosCutoverAt,
  NETWORK_FEE_USD_MICROS_METER,
  NETWORK_FEE_USD_NANOS_METER,
  openMeterUsesLiveNetworkInTests,
  requireOpenMeterForUsageReads,
  SIGNED_TICKET_COUNT_METER,
  usdNanosToMicros,
} from "@/lib/openmeter/constants";
import type { MeterQueryRow, OpenMeter } from "@openmeter/sdk";

function avoidOpenMeterNetworkInTests(): boolean {
  return process.env.NODE_ENV === "test" && !openMeterUsesLiveNetworkInTests();
}

/**
 * Fee meter query rows are normalized to USD micros before aggregation.
 * Display with `formatUsdMicros` from `@/lib/format-usd`.
 */
function feeMicrosFromMeterValue(value: unknown): bigint {
  return BigInt(Math.floor(Number(value ?? 0)));
}

function asQueryDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Split a meter query at the nanos cutover so legacy micros and current nanos
 * windows do not overlap (avoids double-count while collector dual-emits).
 */
export function splitMeterQueryAtCutover(
  query: Record<string, unknown>,
  cutover: Date = getNetworkFeeNanosCutoverAt(),
): { legacy: Record<string, unknown> | null; current: Record<string, unknown> | null } {
  const from = asQueryDate(query.from);
  const to = asQueryDate(query.to);

  let legacy: Record<string, unknown> | null = null;
  let current: Record<string, unknown> | null = null;

  if (!from || from < cutover) {
    if (to && to <= cutover) {
      legacy = { ...query };
    } else {
      legacy = { ...query, to: cutover };
    }
  }

  if (!to || to > cutover) {
    if (from && from >= cutover) {
      current = { ...query };
    } else {
      current = { ...query, from: cutover };
    }
  }

  return { legacy, current };
}

function mapRowsToFeeMicros(
  rows: MeterQueryRow[],
  unit: "micros" | "nanos",
): MeterQueryRow[] {
  return rows.map((row) => {
    const raw = feeMicrosFromMeterValue(row.value);
    const micros = unit === "nanos" ? usdNanosToMicros(raw) : raw;
    return { ...row, value: Number(micros) };
  });
}

function isMeterNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const record = err as { statusCode?: number; status?: number; message?: string };
  const status = record.statusCode ?? record.status;
  if (status === 404) {
    return true;
  }
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  return message.includes("not found") && message.includes("meter");
}

async function queryMeterRowsSafe(
  client: OpenMeter,
  meterSlug: string,
  query: Record<string, unknown>,
): Promise<MeterQueryRow[]> {
  try {
    const result = await client.meters.query(meterSlug, query);
    return result.data || [];
  } catch (err) {
    if (meterSlug === NETWORK_FEE_USD_MICROS_METER && isMeterNotFoundError(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Query network-fee usage as USD micros, merging legacy micros (pre-cutover)
 * with nanos (post-cutover) without double-counting the dual-emit window.
 */
export async function queryNetworkFeeMeterRowsAsMicros(
  client: OpenMeter,
  query: Record<string, unknown>,
  cutover: Date = getNetworkFeeNanosCutoverAt(),
): Promise<MeterQueryRow[]> {
  const { legacy, current } = splitMeterQueryAtCutover(query, cutover);
  const [legacyRows, currentRows] = await Promise.all([
    legacy
      ? queryMeterRowsSafe(client, NETWORK_FEE_USD_MICROS_METER, legacy).then((rows) =>
          mapRowsToFeeMicros(rows, "micros"),
        )
      : Promise.resolve([] as MeterQueryRow[]),
    current
      ? queryMeterRowsSafe(client, NETWORK_FEE_USD_NANOS_METER, current).then((rows) =>
          mapRowsToFeeMicros(rows, "nanos"),
        )
      : Promise.resolve([] as MeterQueryRow[]),
  ]);
  return [...legacyRows, ...currentRows];
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

function buildMeterQuery(input: {
  startDate?: string | null;
  endDate?: string | null;
  windowSize: MeterWindowSize;
  clientId: string;
  externalUserId?: string | null;
  groupBy: readonly string[];
}): Record<string, unknown> {
  const query: Record<string, unknown> = {
    windowSize: input.windowSize,
    groupBy: [...input.groupBy],
  };
  if (input.startDate) {
    query.from = new Date(input.startDate);
  }
  if (input.endDate) {
    query.to = new Date(input.endDate);
  }
  if (input.externalUserId) {
    // CloudEvent subject is the compound client_id:external_user_id (matches the customer key).
    query.subject = buildOpenMeterCustomerKey(input.clientId, input.externalUserId);
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
  const countByUser = new Map<string, number>();
  for (const row of input.countRows) {
    const group = (row.groupBy || {}) as Record<string, unknown>;
    const externalUserId = groupByString(group, "external_user_id", "");
    if (!externalUserId) continue;
    if (clientIdFromGroup(group, input.clientId) !== input.clientId) continue;
    countByUser.set(
      externalUserId,
      (countByUser.get(externalUserId) ?? 0) + Math.floor(Number(row.value ?? 0)),
    );
  }

  const feeByUser = new Map<string, bigint>();
  for (const row of input.feeRows) {
    const group = (row.groupBy || {}) as Record<string, unknown>;
    const externalUserId = groupByString(group, "external_user_id", "");
    if (!externalUserId) continue;
    if (input.filterExternalUserId && externalUserId !== input.filterExternalUserId) continue;
    if (clientIdFromGroup(group, input.clientId) !== input.clientId) continue;
    feeByUser.set(
      externalUserId,
      (feeByUser.get(externalUserId) ?? 0n) + feeMicrosFromMeterValue(row.value),
    );
  }

  const externalUserIds = new Set([...countByUser.keys(), ...feeByUser.keys()]);
  const rows: OpenMeterUsageRow[] = [...externalUserIds].map((externalUserId) => ({
    externalUserId,
    requestCount: countByUser.get(externalUserId) ?? 0,
    networkFeeUsdMicros: (feeByUser.get(externalUserId) ?? 0n).toString(),
  }));

  if (rows.length === 0 && input.filterExternalUserId) {
    rows.push({
      externalUserId: input.filterExternalUserId,
      requestCount: countByUser.get(input.filterExternalUserId) ?? 0,
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
      (countByKey.get(key) ?? 0) + Math.floor(Number(row.value ?? 0)),
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
      (feeByKey.get(key) ?? 0n) + feeMicrosFromMeterValue(row.value),
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
): UserPipelineModelMeta | null {
  const group = (row.groupBy || {}) as Record<string, unknown>;
  if (clientIdFromGroup(group, clientId) !== clientId) return null;
  const externalUserId = groupByString(group, "external_user_id", "");
  if (!externalUserId) return null;
  if (filterExternalUserId && externalUserId !== filterExternalUserId) return null;
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
  const countByKey = new Map<string, number>();
  const metaByKey = new Map<
    string,
    { externalUserId: string; pipeline: string; modelId: string }
  >();

  for (const row of input.countRows) {
    const meta = resolveUserPipelineModelMeta(row, input.clientId, input.filterExternalUserId);
    if (!meta) continue;
    metaByKey.set(meta.key, {
      externalUserId: meta.externalUserId,
      pipeline: meta.pipeline,
      modelId: meta.modelId,
    });
    countByKey.set(
      meta.key,
      (countByKey.get(meta.key) ?? 0) + Math.floor(Number(row.value ?? 0)),
    );
  }

  const feeByKey = new Map<string, bigint>();
  for (const row of input.feeRows) {
    const meta = resolveUserPipelineModelMeta(row, input.clientId, input.filterExternalUserId);
    if (!meta) continue;
    metaByKey.set(meta.key, {
      externalUserId: meta.externalUserId,
      pipeline: meta.pipeline,
      modelId: meta.modelId,
    });
    feeByKey.set(
      meta.key,
      (feeByKey.get(meta.key) ?? 0n) + feeMicrosFromMeterValue(row.value),
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
    existing.requestCount += Math.floor(Number(row.value ?? 0));
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
    existing.networkFeeUsdMicros += feeMicrosFromMeterValue(row.value);
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
      (requestsByDay.get(day) ?? 0) + Math.floor(Number(row.value ?? 0)),
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
  return rows.filter((row) => row.externalUserId === input.externalUserId);
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

  const periodQuery = buildMeterQuery({
    clientId: meterClientId,
    startDate: input.startDate,
    endDate: input.endDate,
    windowSize: "MONTH",
    externalUserId: input.externalUserId,
    groupBy: METER_GROUP_BY_DETAIL,
  });

  const [feeRows, countResult] = await Promise.all([
    queryNetworkFeeMeterRowsAsMicros(client, periodQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, periodQuery),
  ]);

  return aggregatePipelineModelRows({
    clientId: meterClientId,
    feeRows,
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

  const dayQuery = buildMeterQuery({
    clientId: meterClientId,
    startDate: input.startDate,
    endDate: input.endDate,
    windowSize: "DAY",
    externalUserId: input.externalUserId,
    groupBy: METER_GROUP_BY_DETAIL,
  });

  const [feeRows, countResult] = await Promise.all([
    queryNetworkFeeMeterRowsAsMicros(client, dayQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, dayQuery),
  ]);

  return aggregateDailyPipelineModelRows({
    clientId: meterClientId,
    feeRows,
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

  const periodQuery = buildMeterQuery({
    clientId: meterClientId,
    startDate: input.startDate,
    endDate: input.endDate,
    windowSize: "MONTH",
    externalUserId: input.externalUserId,
    groupBy: METER_GROUP_BY_USER,
  });

  const [feeRows, countResult] = await Promise.all([
    queryNetworkFeeMeterRowsAsMicros(client, periodQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, periodQuery),
  ]);

  return aggregateUserRows({
    clientId: meterClientId,
    feeRows,
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

  const [feeRows, countResult, dayCountResult] = await Promise.all([
    queryNetworkFeeMeterRowsAsMicros(client, periodQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, periodQuery),
    client.meters.query(SIGNED_TICKET_COUNT_METER, dayQuery),
  ]);

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
      feeRows: [],
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
