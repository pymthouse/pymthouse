/**
 * Neutral BPP ⑥ usage push: pymthouse → NaaP `POST {NAAP_METRICS_URL}/api/v1/metrics/ingest`.
 *
 * This is the authoritative cross-provider usage path (NOT `validate`). pymthouse
 * meters internally in OpenMeter / Kong Konnect (BPP ⑨); here we map those
 * internal rows into the provider-NEUTRAL ⑥ shape and push them. Raw OpenMeter
 * field names MUST NOT appear in the payload — that invariant is asserted before
 * every send (`assertNoLeakedInternalFieldNames`) and conforms to
 * `contracts/billing-provider-protocol/usage-ingest.schema.json`.
 *
 * Gated behind `USAGE_INGEST_PUSH` (default OFF). Flag-off is a strict no-op.
 */

import {
  queryOpenMeterAppDashboardUsage,
  type OpenMeterPipelineModelRow,
} from "@/lib/openmeter/usage-read";
import { usageIngestPushEnabled } from "@/lib/billing/feature-flags";
import { assertNoLeakedInternalFieldNames } from "./forbidden-fields";

/** Per-capability usage, keyed by generic `<pipeline>:<model>` capability id. */
export interface CapabilityUsage {
  tickets?: number;
  /** Decimal USD micros string (`^[0-9]+$`). */
  networkFeeUsdMicros?: string;
}

/** Neutral ⑥ usage-ingest payload (mirrors the C0 schema). */
export interface UsageIngestPayload {
  providerSlug: string;
  accountId: string;
  appId?: string;
  window: { from: string; to: string };
  sessions?: number;
  tickets?: number;
  feeWei?: string;
  networkFeeUsdMicros?: string;
  byCapability?: Record<string, CapabilityUsage>;
}

export interface BuildUsageIngestPayloadInput {
  providerSlug: string;
  /** Provider billing account of record (per D2: the OpenMeter customer/subscription). */
  accountId: string;
  /** Optional app attribution (pymthouse developer-app client id). */
  appId?: string;
  window: { from: string; to: string };
  /** Internal OpenMeter per-pipeline/model rows for the window. */
  pipelineModelRows: OpenMeterPipelineModelRow[];
}

const DEFAULT_PROVIDER_SLUG = "pymthouse";
const INGEST_PATH = "/api/v1/metrics/ingest";
const PUSH_TIMEOUT_MS = 10_000;

function sumNetworkFeeUsdMicros(rows: OpenMeterPipelineModelRow[]): bigint {
  let total = 0n;
  for (const row of rows) {
    total += BigInt(row.networkFeeUsdMicros || "0");
  }
  return total;
}

/** Map internal OpenMeter rows into the neutral ⑥ payload. No internal field names. */
export function buildUsageIngestPayload(
  input: BuildUsageIngestPayloadInput,
): UsageIngestPayload {
  const byCapability: Record<string, CapabilityUsage> = {};
  let totalTickets = 0;

  for (const row of input.pipelineModelRows) {
    const capabilityId = `${row.pipeline}:${row.modelId}`;
    const existing = byCapability[capabilityId];
    const tickets = (existing?.tickets ?? 0) + row.requestCount;
    const fee =
      BigInt(existing?.networkFeeUsdMicros ?? "0") + BigInt(row.networkFeeUsdMicros || "0");
    byCapability[capabilityId] = {
      tickets,
      networkFeeUsdMicros: fee.toString(),
    };
    totalTickets += row.requestCount;
  }

  const payload: UsageIngestPayload = {
    providerSlug: input.providerSlug,
    accountId: input.accountId,
    window: input.window,
    tickets: totalTickets,
    networkFeeUsdMicros: sumNetworkFeeUsdMicros(input.pipelineModelRows).toString(),
  };

  if (input.appId) {
    payload.appId = input.appId;
  }
  if (Object.keys(byCapability).length > 0) {
    payload.byCapability = byCapability;
  }

  // Defense in depth: never let an internal field name escape pymthouse.
  assertNoLeakedInternalFieldNames(payload, "usage-ingest payload");
  return payload;
}

export type PushUsageIngestResult =
  | { status: "disabled" }
  | { status: "skipped"; reason: string }
  | { status: "ok"; httpStatus: number }
  | { status: "error"; reason: string; httpStatus?: number };

function log(
  level: "info" | "warn",
  event: string,
  fields: Record<string, unknown>,
): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

/**
 * Resolve and validate the ingest target URL. The base comes from operator
 * config (`NAAP_METRICS_URL`), not user input, but we still constrain it to
 * http(s) and forbid plaintext http outside explicit opt-in to limit SSRF / data
 * exfiltration surface.
 */
function resolveIngestUrl(): { url: URL } | { error: string } {
  const base = process.env.NAAP_METRICS_URL?.trim();
  if (!base) {
    return { error: "NAAP_METRICS_URL not configured" };
  }

  let url: URL;
  try {
    url = new URL(INGEST_PATH, base.endsWith("/") ? base : `${base}/`);
  } catch {
    return { error: "NAAP_METRICS_URL is not a valid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: `unsupported protocol: ${url.protocol}` };
  }

  const allowInsecure =
    process.env.ALLOW_INSECURE_HTTP === "1" ||
    process.env.ALLOW_INSECURE_HTTP?.toLowerCase() === "true";
  if (url.protocol === "http:" && !allowInsecure) {
    return { error: "plaintext http blocked (set ALLOW_INSECURE_HTTP=1 to allow)" };
  }

  return { url };
}

/**
 * Push a neutral ⑥ payload to NaaP. Flag-off → no-op. Missing config or transport
 * failures are logged and returned as non-throwing results so callers never break
 * the metering path on a downstream outage.
 */
export async function pushUsageIngest(
  payload: UsageIngestPayload,
  options?: { correlationId?: string; fetchImpl?: typeof fetch },
): Promise<PushUsageIngestResult> {
  if (!usageIngestPushEnabled()) {
    return { status: "disabled" };
  }

  // Re-assert isolation in case a caller hand-built the payload.
  assertNoLeakedInternalFieldNames(payload, "usage-ingest payload");

  const token = process.env.NAAP_METRICS_INGEST_TOKEN?.trim();
  if (!token) {
    log("warn", "bpp.usage_ingest.skipped", { reason: "missing_token" });
    return { status: "skipped", reason: "NAAP_METRICS_INGEST_TOKEN not configured" };
  }

  const resolved = resolveIngestUrl();
  if ("error" in resolved) {
    log("warn", "bpp.usage_ingest.skipped", { reason: resolved.error });
    return { status: "skipped", reason: resolved.error };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    if (options?.correlationId) {
      headers["x-request-id"] = options.correlationId;
    }

    const response = await fetchImpl(resolved.url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      log("warn", "bpp.usage_ingest.rejected", {
        providerSlug: payload.providerSlug,
        hasApp: Boolean(payload.appId),
        httpStatus: response.status,
      });
      return {
        status: "error",
        reason: `ingest returned ${response.status}`,
        httpStatus: response.status,
      };
    }

    log("info", "bpp.usage_ingest.accepted", {
      providerSlug: payload.providerSlug,
      hasApp: Boolean(payload.appId),
      httpStatus: response.status,
    });
    return { status: "ok", httpStatus: response.status };
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown_error";
    log("warn", "bpp.usage_ingest.failed", {
      providerSlug: payload.providerSlug,
      hasApp: Boolean(payload.appId),
      reason,
    });
    return { status: "error", reason };
  } finally {
    clearTimeout(timeout);
  }
}

export interface PushAppUsageInput {
  /** pymthouse developer-app client id (used as ⑥ appId). */
  clientId: string;
  /** Provider billing account of record for this app (per D2). */
  accountId: string;
  startDate?: string | null;
  endDate?: string | null;
  providerSlug?: string;
  correlationId?: string;
  fetchImpl?: typeof fetch;
}

/** Default window: start of the current UTC month → now. */
function defaultWindow(start?: string | null, end?: string | null): { from: string; to: string } {
  const now = new Date();
  const from = start
    ? new Date(start)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = end ? new Date(end) : now;
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Read this app's internal OpenMeter usage for the window and push it as a
 * neutral ⑥ payload. Flag-off → no-op. Safe to call from a scheduled job or a
 * billing-sync hook.
 */
export async function pushAppUsageToNaaP(
  input: PushAppUsageInput,
): Promise<PushUsageIngestResult> {
  if (!usageIngestPushEnabled()) {
    return { status: "disabled" };
  }

  const window = defaultWindow(input.startDate, input.endDate);
  const dashboard = await queryOpenMeterAppDashboardUsage({
    clientId: input.clientId,
    startDate: window.from,
    endDate: window.to,
  });

  const payload = buildUsageIngestPayload({
    providerSlug: input.providerSlug ?? DEFAULT_PROVIDER_SLUG,
    accountId: input.accountId,
    appId: input.clientId,
    window,
    pipelineModelRows: dashboard?.byPipelineModel ?? [],
  });

  return pushUsageIngest(payload, {
    correlationId: input.correlationId,
    fetchImpl: input.fetchImpl,
  });
}
