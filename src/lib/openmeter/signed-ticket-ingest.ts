/**
 * Durable, idempotent, acked OpenMeter writer for `create_signed_ticket` usage
 * events posted synchronously to `POST /api/v1/internal/ingest/signed-ticket`.
 *
 * Background: billed BYOC usage historically reached OpenMeter only through a
 * best-effort fire-and-forget pipeline (go-livepeer `SendQueueEventAsync` →
 * in-process Kafka producer → Redpanda → Benthos `openmeter-collector` →
 * OpenMeter) with several silent-drop branches and no delivery guarantee, so
 * billed jobs were lost from metering. This module provides the missing durable
 * path: it writes the CloudEvent to OpenMeter and only acks once the write is
 * accepted, deduping on `(clientId, requestId)` so retries and a parallel legacy
 * Kafka path never double-count.
 *
 * The CloudEvent shape (subject `client_id:external_user_id`, id = requestId,
 * `network_fee_usd_micros`, etc.) is produced by the shared
 * {@link ingestSignedTicketEvent} writer so it aggregates with the meters the
 * Benthos collector already feeds. Idempotency is enforced at two layers:
 *  1. the `usage_ingest_receipts` unique index on `(client_id, request_id)`, and
 *  2. OpenMeter's own dedupe on the CloudEvent `id` (= request_id).
 *
 * All external effects (app resolution, receipt store, OpenMeter write) are
 * injected through {@link SignedTicketIngestDeps} so the core flow is unit
 * testable without a database or network.
 */

import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { db } from "@/db/index";
import { usageIngestReceipts } from "@/db/schema";
import { getProviderApp } from "@/lib/provider-apps";
import { getHostedOpenMeterClient } from "./client";
import { openMeterUsesLiveNetworkInTests } from "./constants";
import { ingestSignedTicketEvent } from "./entitlements";
import { __testAccumulateOpenMeterUsage } from "./usage-read";

/** Default ETH/USD price used to mirror the Benthos collector when the signer
 * does not pre-compute `computed_fee_usd_micros`. Matches `deploy/collector.yaml`. */
const DEFAULT_ETH_USD_PRICE = 3500;

/** Marker prefix for diagnostic-only receipts (never a durable OpenMeter write). */
const DIAGNOSTIC_RECEIPT_PREFIX = "diagnostic:";

/** Normalized usage event extracted from the ingest request body. */
export interface DurableSignedTicketEvent {
  /** Public OIDC client id (becomes `data.client_id` + part of the subject). */
  clientId: string;
  /** End-user attribution, e.g. `naap-storyboard-preview`. */
  externalUserId: string;
  /** Unique per-job id; the CloudEvent `id` and idempotency key. */
  requestId: string;
  /** Network fee in USD micros (already resolved; non-negative integer string). */
  networkFeeUsdMicros: string;
  feeWei?: string;
  pixels?: string;
  pipeline?: string;
  modelId?: string;
  ethUsdPrice?: string;
  ethUsdObservedAt?: string;
}

/** Receipt row shape the dedupe fast-path needs. */
export interface SignedTicketReceipt {
  openmeterEventId: string;
}

/** Injectable side effects so the core flow can be unit tested in isolation. */
export interface SignedTicketIngestDeps {
  /** Resolve the developer-app primary key for an incoming client id. */
  resolveAppId(clientId: string): Promise<string | null>;
  /** Look up an existing receipt for the `(appId, requestId)` idempotency key. */
  findReceipt(appId: string, requestId: string): Promise<SignedTicketReceipt | null>;
  /** Idempotently persist the receipt for the `(appId, requestId)` key. */
  upsertReceipt(input: {
    appId: string;
    requestId: string;
    openmeterEventId: string;
    externalUserId: string;
  }): Promise<void>;
  /** Write the CloudEvent to OpenMeter (must be idempotent on the event id). */
  writeOpenMeterEvent(event: DurableSignedTicketEvent): Promise<void>;
}

export type DurableSignedTicketIngestResult =
  | { status: "unknown_client" }
  | { status: "ingested"; openmeterEventId: string; duplicate: false }
  | { status: "duplicate"; openmeterEventId: string; duplicate: true };

/** Parse a non-negative integer string; returns null for invalid/negative input. */
function parseNonNegativeIntString(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  // Normalize (strip leading zeros) via BigInt without losing precision.
  return BigInt(trimmed).toString();
}

function resolveEthUsdPrice(explicit?: string): number {
  const candidates = [explicit, process.env.ETH_USD_PRICE];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = parseFloat(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_ETH_USD_PRICE;
}

/**
 * Resolve `network_fee_usd_micros` for the event, trusting the signer's
 * pre-computed `computed_fee_usd_micros` when present and otherwise mirroring the
 * Benthos collector mapping (`round(fee_wei * eth_usd / 1e12)`). Returns null
 * when no usable fee can be derived.
 */
export function resolveNetworkFeeUsdMicros(input: {
  computedFeeUsdMicros?: string;
  computedFeeWei?: string;
  ethUsdPrice?: string;
}): string | null {
  const preComputed = parseNonNegativeIntString(input.computedFeeUsdMicros);
  if (preComputed !== null) {
    return preComputed;
  }

  const wei = parseNonNegativeIntString(input.computedFeeWei);
  if (wei === null) {
    return null;
  }
  const ethUsd = resolveEthUsdPrice(input.ethUsdPrice);
  // Mirror collector.yaml: ($fee_wei * $eth_usd / 1e12).round()
  const micros = Math.round((Number(wei) * ethUsd) / 1_000_000_000_000);
  if (!Number.isFinite(micros) || micros < 0) {
    return null;
  }
  return String(micros);
}

/** Default OpenMeter writer; uses the in-memory test accumulator under test. */
async function defaultWriteOpenMeterEvent(event: DurableSignedTicketEvent): Promise<void> {
  if (process.env.NODE_ENV === "test" && !openMeterUsesLiveNetworkInTests()) {
    // Route writes into the same in-memory meter stubs the usage reads consult,
    // so integration tests can assert OpenMeter deltas without a live backend.
    __testAccumulateOpenMeterUsage({
      clientId: event.clientId,
      externalUserId: event.externalUserId,
      networkFeeUsdMicros: event.networkFeeUsdMicros,
      pipeline: event.pipeline,
      modelId: event.modelId,
    });
    return;
  }

  const client = getHostedOpenMeterClient();
  if (!client) {
    throw new Error("OpenMeter client is not configured (set OPENMETER_URL)");
  }
  await ingestSignedTicketEvent({
    client,
    event: {
      requestId: event.requestId,
      clientId: event.clientId,
      externalUserId: event.externalUserId,
      networkFeeUsdMicros: event.networkFeeUsdMicros,
      feeWei: event.feeWei,
      pixels: event.pixels,
      pipeline: event.pipeline,
      modelId: event.modelId,
      gatewayRequestId: event.requestId,
      ethUsdPrice: event.ethUsdPrice,
      ethUsdObservedAt: event.ethUsdObservedAt,
    },
  });
}

/** Production wiring for the durable ingest side effects. */
export function defaultSignedTicketIngestDeps(): SignedTicketIngestDeps {
  return {
    resolveAppId: async (clientId) => {
      const app = await getProviderApp(clientId);
      return app?.id ?? null;
    },
    findReceipt: async (appId, requestId) => {
      const rows = await db
        .select({ openmeterEventId: usageIngestReceipts.openmeterEventId })
        .from(usageIngestReceipts)
        .where(
          and(
            eq(usageIngestReceipts.clientId, appId),
            eq(usageIngestReceipts.requestId, requestId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    upsertReceipt: async (input) => {
      await db
        .insert(usageIngestReceipts)
        .values({
          id: uuidv4(),
          clientId: input.appId,
          requestId: input.requestId,
          openmeterEventId: input.openmeterEventId,
          externalUserId: input.externalUserId,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: [usageIngestReceipts.clientId, usageIngestReceipts.requestId],
          set: {
            openmeterEventId: input.openmeterEventId,
            externalUserId: input.externalUserId,
          },
        });
    },
    writeOpenMeterEvent: defaultWriteOpenMeterEvent,
  };
}

function isDurableReceipt(receipt: SignedTicketReceipt | null): boolean {
  return Boolean(
    receipt && !receipt.openmeterEventId.startsWith(DIAGNOSTIC_RECEIPT_PREFIX),
  );
}

/**
 * Durably ingest one signed-ticket usage event into OpenMeter.
 *
 * Flow: resolve the app → short-circuit if a durable receipt already exists
 * (return `duplicate`) → write the CloudEvent to OpenMeter (id = requestId, so
 * OpenMeter dedupes redundant writes) → record/refresh the receipt. The
 * OpenMeter write happens before the receipt is recorded so a receipt always
 * implies an accepted write; this is what lets the caller ack `ingested:true`.
 */
export async function ingestSignedTicketDurable(
  event: DurableSignedTicketEvent,
  depsOverride?: Partial<SignedTicketIngestDeps>,
): Promise<DurableSignedTicketIngestResult> {
  const deps = { ...defaultSignedTicketIngestDeps(), ...depsOverride };

  const appId = await deps.resolveAppId(event.clientId);
  if (!appId) {
    return { status: "unknown_client" };
  }

  const existing = await deps.findReceipt(appId, event.requestId);
  if (isDurableReceipt(existing) && existing) {
    return {
      status: "duplicate",
      openmeterEventId: existing.openmeterEventId,
      duplicate: true,
    };
  }

  const openmeterEventId = event.requestId;
  await deps.writeOpenMeterEvent(event);
  await deps.upsertReceipt({
    appId,
    requestId: event.requestId,
    openmeterEventId,
    externalUserId: event.externalUserId,
  });

  return { status: "ingested", openmeterEventId, duplicate: false };
}
