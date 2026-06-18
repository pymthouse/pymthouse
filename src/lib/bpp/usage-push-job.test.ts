import test from "node:test";
import assert from "node:assert/strict";

import { runUsageIngestPushJob, type UsagePushAccount } from "./usage-push-job";
import { findLeakedInternalFieldNames } from "./forbidden-fields";
import {
  __testClearOpenMeterUsageStubs,
  __testSetOpenMeterDashboardUsage,
} from "@/lib/openmeter/usage-read";

const FIXED_NOW = new Date("2026-06-18T12:00:00.000Z");
const DECIMAL = /^\d+$/;

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

test("runUsageIngestPushJob fires a C0-conformant push per account when the flag is ON", async () => {
  await withEnv(
    {
      USAGE_INGEST_PUSH: "1",
      NAAP_METRICS_URL: "https://naap.example",
      NAAP_METRICS_INGEST_TOKEN: "super-secret-token",
    },
    async () => {
      const clientId = "app_push_test";
      __testSetOpenMeterDashboardUsage(clientId, {
        byUser: [],
        byPipelineModel: [
          {
            pipeline: "text-to-image",
            modelId: "sdxl",
            requestCount: 4,
            networkFeeUsdMicros: "2000",
          },
          {
            pipeline: "text-to-video",
            modelId: "ltx",
            requestCount: 2,
            networkFeeUsdMicros: "4000",
          },
        ],
        byUserPipelineModel: [],
        requestsByDay: new Map(),
      });

      const captured: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        captured.push({
          url,
          body: JSON.parse(init?.body as string),
          auth: headers.authorization,
        });
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }) as unknown as typeof fetch;

      const accounts: UsagePushAccount[] = [{ clientId, accountId: "acct_om_42" }];

      const summary = await runUsageIngestPushJob({
        listAccounts: async () => accounts,
        fetchImpl,
        now: () => FIXED_NOW,
        correlationId: "cron-corr-1",
      });

      try {
        assert.equal(summary.enabled, true);
        assert.equal(summary.attempted, 1);
        assert.equal(summary.pushed, 1);
        assert.equal(summary.errors, 0);
        assert.deepEqual(summary.results, [{ clientId, status: "ok" }]);

        assert.equal(captured.length, 1);
        const sent = captured[0];
        assert.equal(sent.url, "https://naap.example/api/v1/metrics/ingest");
        assert.equal(sent.auth, "Bearer super-secret-token");

        // C0 (usage-ingest.schema.json) conformance + seam isolation.
        assert.equal(sent.body.providerSlug, "pymthouse");
        assert.equal(sent.body.accountId, "acct_om_42");
        assert.equal(sent.body.appId, clientId);
        const window = sent.body.window as { from: string; to: string };
        assert.equal(window.to, FIXED_NOW.toISOString());
        assert.ok(!Number.isNaN(Date.parse(window.from)));
        assert.ok(Date.parse(window.from) < Date.parse(window.to));
        assert.equal(sent.body.tickets, 6);
        assert.match(sent.body.networkFeeUsdMicros as string, DECIMAL);
        assert.equal(sent.body.networkFeeUsdMicros, "6000");
        const byCapability = sent.body.byCapability as Record<
          string,
          { tickets?: number; networkFeeUsdMicros?: string }
        >;
        assert.deepEqual(byCapability["text-to-image:sdxl"], {
          tickets: 4,
          networkFeeUsdMicros: "2000",
        });
        assert.deepEqual(findLeakedInternalFieldNames(sent.body), []);
      } finally {
        __testClearOpenMeterUsageStubs();
      }
    },
  );
});

test("runUsageIngestPushJob is a strict no-op when the flag is OFF (no enumeration, no network)", async () => {
  await withEnv(
    {
      USAGE_INGEST_PUSH: undefined,
      NAAP_METRICS_URL: "https://naap.example",
      NAAP_METRICS_INGEST_TOKEN: "super-secret-token",
    },
    async () => {
      let listAccountsCalled = false;
      let fetchCalled = false;
      const fetchImpl = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const summary = await runUsageIngestPushJob({
        listAccounts: async () => {
          listAccountsCalled = true;
          return [{ clientId: "app_x", accountId: "acct_x" }];
        },
        fetchImpl,
        now: () => FIXED_NOW,
      });

      assert.equal(summary.enabled, false);
      assert.equal(summary.window, null);
      assert.equal(summary.attempted, 0);
      assert.deepEqual(summary.results, []);
      // Flag-off must not even enumerate accounts or touch the network.
      assert.equal(listAccountsCalled, false);
      assert.equal(fetchCalled, false);
    },
  );
});
