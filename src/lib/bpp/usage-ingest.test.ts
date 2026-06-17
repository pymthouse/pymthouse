import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUsageIngestPayload,
  pushUsageIngest,
  type UsageIngestPayload,
} from "./usage-ingest";
import { findLeakedInternalFieldNames } from "./forbidden-fields";
import type { OpenMeterPipelineModelRow } from "@/lib/openmeter/usage-read";

const PIPELINE_ROWS: OpenMeterPipelineModelRow[] = [
  { pipeline: "text-to-image", modelId: "sdxl", requestCount: 3, networkFeeUsdMicros: "1500" },
  { pipeline: "text-to-video", modelId: "ltx", requestCount: 2, networkFeeUsdMicros: "4000" },
  { pipeline: "text-to-image", modelId: "sdxl", requestCount: 1, networkFeeUsdMicros: "500" },
];

const WINDOW = { from: "2026-06-01T00:00:00.000Z", to: "2026-06-17T00:00:00.000Z" };

const DECIMAL = /^[0-9]+$/;

/** Assert a payload conforms to the C0 usage-ingest schema constraints. */
function assertConformsToC0(payload: UsageIngestPayload): void {
  assert.equal(typeof payload.providerSlug, "string");
  assert.ok(payload.providerSlug.length >= 1);
  assert.equal(typeof payload.accountId, "string");
  assert.ok(payload.accountId.length >= 1);
  assert.ok(!Number.isNaN(Date.parse(payload.window.from)));
  assert.ok(!Number.isNaN(Date.parse(payload.window.to)));
  if (payload.tickets !== undefined) {
    assert.ok(Number.isInteger(payload.tickets) && payload.tickets >= 0);
  }
  if (payload.networkFeeUsdMicros !== undefined) {
    assert.match(payload.networkFeeUsdMicros, DECIMAL);
  }
  if (payload.feeWei !== undefined) {
    assert.match(payload.feeWei, DECIMAL);
  }
  for (const [capId, usage] of Object.entries(payload.byCapability ?? {})) {
    assert.match(capId, /^[^:]+:[^:]+$/, "capability id must be <pipeline>:<model>");
    if (usage.tickets !== undefined) {
      assert.ok(Number.isInteger(usage.tickets) && usage.tickets >= 0);
    }
    if (usage.networkFeeUsdMicros !== undefined) {
      assert.match(usage.networkFeeUsdMicros, DECIMAL);
    }
  }
  // Seam isolation: no provider-internal (OpenMeter) field names anywhere.
  assert.deepEqual(findLeakedInternalFieldNames(payload), []);
}

test("buildUsageIngestPayload maps internal rows into a C0-conformant neutral payload", () => {
  const payload = buildUsageIngestPayload({
    providerSlug: "pymthouse",
    accountId: "acct_om_42",
    appId: "app_123",
    window: WINDOW,
    pipelineModelRows: PIPELINE_ROWS,
  });

  assertConformsToC0(payload);
  assert.equal(payload.appId, "app_123");
  assert.equal(payload.tickets, 6);
  assert.equal(payload.networkFeeUsdMicros, "6000");
  // Same pipeline:model rows are aggregated.
  assert.deepEqual(payload.byCapability?.["text-to-image:sdxl"], {
    tickets: 4,
    networkFeeUsdMicros: "2000",
  });
  assert.deepEqual(payload.byCapability?.["text-to-video:ltx"], {
    tickets: 2,
    networkFeeUsdMicros: "4000",
  });
});

test("buildUsageIngestPayload omits appId and byCapability when empty", () => {
  const payload = buildUsageIngestPayload({
    providerSlug: "pymthouse",
    accountId: "acct_om_42",
    window: WINDOW,
    pipelineModelRows: [],
  });
  assertConformsToC0(payload);
  assert.ok(!("appId" in payload));
  assert.ok(!("byCapability" in payload));
  assert.equal(payload.tickets, 0);
  assert.equal(payload.networkFeeUsdMicros, "0");
});

const VALID_PAYLOAD: UsageIngestPayload = {
  providerSlug: "pymthouse",
  accountId: "acct_om_42",
  window: WINDOW,
  tickets: 1,
  networkFeeUsdMicros: "100",
};

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> | void {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const k of keys) {
      const prev = previous.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("pushUsageIngest is a strict no-op when the flag is OFF (no network call)", async () => {
  await withEnv(
    {
      USAGE_INGEST_PUSH: undefined,
      NAAP_METRICS_URL: "https://naap.example",
      NAAP_METRICS_INGEST_TOKEN: "tok",
    },
    async () => {
      let called = false;
      const fetchImpl = (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const result = await pushUsageIngest(VALID_PAYLOAD, { fetchImpl });
      assert.equal(result.status, "disabled");
      assert.equal(called, false);
    },
  );
});

test("pushUsageIngest posts to the neutral ingest endpoint with bearer auth when enabled", async () => {
  await withEnv(
    {
      USAGE_INGEST_PUSH: "1",
      NAAP_METRICS_URL: "https://naap.example",
      NAAP_METRICS_INGEST_TOKEN: "super-secret-token",
    },
    async () => {
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }) as unknown as typeof fetch;

      const result = await pushUsageIngest(VALID_PAYLOAD, {
        correlationId: "corr-1",
        fetchImpl,
      });

      assert.equal(result.status, "ok");
      assert.equal(capturedUrl, "https://naap.example/api/v1/metrics/ingest");
      assert.equal(capturedInit?.method, "POST");
      const headers = capturedInit?.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer super-secret-token");
      assert.equal(headers["x-request-id"], "corr-1");
      const sentBody = JSON.parse(capturedInit?.body as string);
      assert.deepEqual(sentBody, VALID_PAYLOAD);
      assert.deepEqual(findLeakedInternalFieldNames(sentBody), []);
    },
  );
});

test("pushUsageIngest skips (no throw) when the ingest token is missing", async () => {
  await withEnv(
    {
      USAGE_INGEST_PUSH: "1",
      NAAP_METRICS_URL: "https://naap.example",
      NAAP_METRICS_INGEST_TOKEN: undefined,
    },
    async () => {
      let called = false;
      const fetchImpl = (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const result = await pushUsageIngest(VALID_PAYLOAD, { fetchImpl });
      assert.equal(result.status, "skipped");
      assert.equal(called, false);
    },
  );
});

test("pushUsageIngest blocks plaintext http exfiltration by default (SSRF hardening)", async () => {
  await withEnv(
    {
      USAGE_INGEST_PUSH: "1",
      NAAP_METRICS_URL: "http://attacker.internal",
      NAAP_METRICS_INGEST_TOKEN: "tok",
      ALLOW_INSECURE_HTTP: undefined,
    },
    async () => {
      let called = false;
      const fetchImpl = (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const result = await pushUsageIngest(VALID_PAYLOAD, { fetchImpl });
      assert.equal(result.status, "skipped");
      assert.equal(called, false);
    },
  );
});

test("pushUsageIngest refuses to send a payload carrying provider-internal field names", async () => {
  await withEnv(
    {
      USAGE_INGEST_PUSH: "1",
      NAAP_METRICS_URL: "https://naap.example",
      NAAP_METRICS_INGEST_TOKEN: "tok",
    },
    async () => {
      const leaky = {
        ...VALID_PAYLOAD,
        openmeter_subscription_id: "01J...",
      } as unknown as UsageIngestPayload;
      await assert.rejects(() => Promise.resolve(pushUsageIngest(leaky)), /seam isolation violation/);
    },
  );
});
