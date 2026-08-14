import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  isSettlementCollectConfigured,
  requestSettlementCollect,
} from "@/lib/billing/settlement-collect-client";

const KEYS = ["SETTLEMENT_COLLECT_REQUEST_URL", "SETTLEMENT_COLLECT_REQUEST_SECRET"] as const;

function snapshotEnv(): Record<(typeof KEYS)[number], string | undefined> {
  return Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
    (typeof KEYS)[number],
    string | undefined
  >;
}

function restoreEnv(snapshot: Record<(typeof KEYS)[number], string | undefined>): void {
  for (const key of KEYS) {
    const prev = snapshot[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("settlement-collect-client", () => {
  let envSnapshot: Record<(typeof KEYS)[number], string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    globalThis.fetch = originalFetch;
  });

  it("is unavailable without a configured url and secret", async () => {
    delete process.env.SETTLEMENT_COLLECT_REQUEST_URL;
    delete process.env.SETTLEMENT_COLLECT_REQUEST_SECRET;

    assert.equal(isSettlementCollectConfigured(), false);
    assert.equal(
      await requestSettlementCollect({
        clientId: "app_1",
        externalUserId: "eu_1",
        customerId: "cus_om_1",
        force: false,
      }),
      "unavailable",
    );
  });

  it("posts the request with the shared secret and returns queued on 200", async () => {
    process.env.SETTLEMENT_COLLECT_REQUEST_URL = "https://settlement.example.com/requests/collect";
    process.env.SETTLEMENT_COLLECT_REQUEST_SECRET = "collect_secret_test";

    let gotUrl = "";
    let gotAuth = "";
    let gotBody: Record<string, unknown> = {};
    globalThis.fetch = async (input, init) => {
      gotUrl = String(input);
      gotAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      gotBody = JSON.parse(String(init?.body));
      return jsonResponse({ received: true });
    };

    assert.equal(isSettlementCollectConfigured(), true);
    const outcome = await requestSettlementCollect({
      clientId: "app_1",
      externalUserId: "eu_1",
      customerId: "cus_om_1",
      force: true,
    });

    assert.equal(outcome, "queued");
    assert.equal(gotUrl, "https://settlement.example.com/requests/collect");
    assert.equal(gotAuth, "Bearer collect_secret_test");
    assert.equal(gotBody.clientId, "app_1");
    assert.equal(gotBody.externalUserId, "eu_1");
    assert.equal(gotBody.customerId, "cus_om_1");
    assert.equal(gotBody.force, true);
    assert.equal(typeof gotBody.requestId, "string");
    assert.ok((gotBody.requestId as string).length > 0);
  });

  it("mints a distinct requestId per call", async () => {
    process.env.SETTLEMENT_COLLECT_REQUEST_URL = "https://settlement.example.com/requests/collect";
    process.env.SETTLEMENT_COLLECT_REQUEST_SECRET = "collect_secret_test";

    const seen: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push(body.requestId);
      return jsonResponse({ received: true });
    };

    const input = { clientId: "app_1", externalUserId: "eu_1", customerId: "cus_om_1", force: false };
    await requestSettlementCollect(input);
    await requestSettlementCollect(input);

    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
  });

  it("returns error on a non-2xx response without throwing", async () => {
    process.env.SETTLEMENT_COLLECT_REQUEST_URL = "https://settlement.example.com/requests/collect";
    process.env.SETTLEMENT_COLLECT_REQUEST_SECRET = "collect_secret_test";
    globalThis.fetch = async () => jsonResponse({ error: "invalid secret" }, 401);

    const outcome = await requestSettlementCollect({
      clientId: "app_1",
      externalUserId: "eu_1",
      customerId: "cus_om_1",
      force: false,
    });

    assert.equal(outcome, "error");
  });

  it("returns error when the network call itself fails", async () => {
    process.env.SETTLEMENT_COLLECT_REQUEST_URL = "https://settlement.example.com/requests/collect";
    process.env.SETTLEMENT_COLLECT_REQUEST_SECRET = "collect_secret_test";
    globalThis.fetch = async () => {
      throw new Error("network unreachable");
    };

    const outcome = await requestSettlementCollect({
      clientId: "app_1",
      externalUserId: "eu_1",
      customerId: "cus_om_1",
      force: false,
    });

    assert.equal(outcome, "error");
  });
});
