import test from "node:test";
import assert from "node:assert/strict";

import {
  ingestSignedTicketDurable,
  resolveNetworkFeeUsdMicros,
  type DurableSignedTicketEvent,
  type SignedTicketIngestDeps,
} from "./signed-ticket-ingest";

const BASE_EVENT: DurableSignedTicketEvent = {
  clientId: "app_known",
  externalUserId: "naap-storyboard-preview",
  requestId: "req-1",
  networkFeeUsdMicros: "547000",
  pipeline: "live-video-to-video",
  modelId: "streamdiffusion",
};

/** In-memory deps so the durable flow is exercised without a DB or OpenMeter. */
function makeDeps(knownClientIds: string[] = ["app_known"]) {
  const writes: DurableSignedTicketEvent[] = [];
  const receipts = new Map<string, string>();
  const key = (appId: string, requestId: string) => `${appId}|${requestId}`;

  const deps: Partial<SignedTicketIngestDeps> = {
    resolveAppId: async (clientId) =>
      knownClientIds.includes(clientId) ? clientId : null,
    findReceipt: async (appId, requestId) => {
      const openmeterEventId = receipts.get(key(appId, requestId));
      return openmeterEventId ? { openmeterEventId } : null;
    },
    upsertReceipt: async ({ appId, requestId, openmeterEventId }) => {
      receipts.set(key(appId, requestId), openmeterEventId);
    },
    writeOpenMeterEvent: async (event) => {
      writes.push(event);
    },
  };
  return { deps, writes, receipts };
}

test("durable ingest writes to OpenMeter exactly once and acks ingested", async () => {
  const { deps, writes, receipts } = makeDeps();

  const result = await ingestSignedTicketDurable(BASE_EVENT, deps);

  assert.equal(result.status, "ingested");
  assert.equal(result.duplicate, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].requestId, "req-1");
  assert.equal(writes[0].networkFeeUsdMicros, "547000");
  // Receipt key is (clientId, requestId); openmeter event id is the request id.
  assert.equal(receipts.get("app_known|req-1"), "req-1");
  assert.equal(result.status === "ingested" && result.openmeterEventId, "req-1");
});

test("durable ingest is idempotent: a duplicate (clientId, requestId) meters once", async () => {
  const { deps, writes } = makeDeps();

  const first = await ingestSignedTicketDurable(BASE_EVENT, deps);
  const second = await ingestSignedTicketDurable(BASE_EVENT, deps);

  assert.equal(first.status, "ingested");
  assert.equal(first.duplicate, false);
  assert.equal(second.status, "duplicate");
  assert.equal(second.duplicate, true);
  // The OpenMeter write happened exactly once across both calls.
  assert.equal(writes.length, 1);
});

test("durable ingest rejects an unknown client without writing", async () => {
  const { deps, writes } = makeDeps([]);

  const result = await ingestSignedTicketDurable(BASE_EVENT, deps);

  assert.equal(result.status, "unknown_client");
  assert.equal(writes.length, 0);
});

test("durable ingest upgrades a prior diagnostic receipt to a real write", async () => {
  const { deps, writes, receipts } = makeDeps();
  // Simulate a receipt left by the legacy diagnostic path (no OpenMeter write).
  receipts.set("app_known|req-1", "diagnostic:req-1");

  const result = await ingestSignedTicketDurable(BASE_EVENT, deps);

  assert.equal(result.status, "ingested");
  assert.equal(result.duplicate, false);
  assert.equal(writes.length, 1);
  assert.equal(receipts.get("app_known|req-1"), "req-1");
});

test("distinct request ids each produce one OpenMeter write (delta == N)", async () => {
  const { deps, writes } = makeDeps();
  const n = 5;

  for (let i = 0; i < n; i++) {
    const result = await ingestSignedTicketDurable(
      { ...BASE_EVENT, requestId: `req-${i}` },
      deps,
    );
    assert.equal(result.status, "ingested");
  }

  assert.equal(writes.length, n);
});

test("resolveNetworkFeeUsdMicros prefers the signer's pre-computed usd micros", () => {
  const micros = resolveNetworkFeeUsdMicros({
    computedFeeUsdMicros: "547000",
    computedFeeWei: "1000000000",
    ethUsdPrice: "3500",
  });
  assert.equal(micros, "547000");
});

test("resolveNetworkFeeUsdMicros falls back to fee_wei × eth_usd / 1e12", () => {
  // 2e9 wei × 3500 / 1e12 = 7 USD micros.
  const micros = resolveNetworkFeeUsdMicros({
    computedFeeWei: "2000000000",
    ethUsdPrice: "3500",
  });
  assert.equal(micros, "7");
});

test("resolveNetworkFeeUsdMicros returns null for missing or garbage fees", () => {
  assert.equal(resolveNetworkFeeUsdMicros({}), null);
  assert.equal(resolveNetworkFeeUsdMicros({ computedFeeWei: "abc" }), null);
  assert.equal(resolveNetworkFeeUsdMicros({ computedFeeUsdMicros: "-5" }), null);
});

test("resolveNetworkFeeUsdMicros accepts a zero fee as a valid value", () => {
  assert.equal(resolveNetworkFeeUsdMicros({ computedFeeUsdMicros: "0" }), "0");
});
