import assert from "node:assert/strict";
import test from "node:test";

import { ingestTestUsageEvent } from "./test-usage-event";

type TestUsageDeps = NonNullable<Parameters<typeof ingestTestUsageEvent>[1]>;

function createDeps(overrides: Partial<TestUsageDeps> = {}): TestUsageDeps {
  const fakeClient = {} as ReturnType<TestUsageDeps["getHostedAdminClient"]>;
  return {
    isHostedAdminClientAvailable: () => true,
    parseTopUpAmountUsd: () => ({ ok: true, amountUsdMicros: 12_340_000n }),
    getHostedAdminClient: () => fakeClient,
    ensureOpenMeterCustomerForAppUser: async () => ({
      id: "customer_1",
      key: "pc_123:eu_123",
    }),
    ingestSignedTicketEvent: async () => undefined,
    invoiceGatheringForIdentity: async () => ({
      outcome: "invoiced",
      invoiceIds: ["inv_1"],
    }),
    formatUsdMicrosForDisplay: (amountUsdMicros: string) => `usd:${amountUsdMicros}`,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    sleep: async () => undefined,
    ...overrides,
  };
}

test("ingestTestUsageEvent rejects when OpenMeter admin client is unavailable", async () => {
  await assert.rejects(
    () =>
      ingestTestUsageEvent(
        {
          publicClientId: "pc_123",
          externalUserId: "eu_123",
          amountUsd: "12.34",
        },
        createDeps({
          isHostedAdminClientAvailable: () => false,
        }),
      ),
    /OpenMeter is not configured/,
  );
});

test("ingestTestUsageEvent rejects malformed amountUsd", async () => {
  await assert.rejects(
    () =>
      ingestTestUsageEvent(
        {
          publicClientId: "pc_123",
          externalUserId: "eu_123",
          amountUsd: "bad",
        },
        createDeps({
          parseTopUpAmountUsd: () => ({ ok: false, error: "amountUsd invalid" }),
        }),
      ),
    /amountUsd invalid/,
  );
});

test("ingestTestUsageEvent requires non-empty client and external user ids", async () => {
  await assert.rejects(
    () =>
      ingestTestUsageEvent(
        {
          publicClientId: "   ",
          externalUserId: "eu_123",
          amountUsd: "12.34",
        },
        createDeps(),
      ),
    /publicClientId and externalUserId are required/,
  );
});

test("ingestTestUsageEvent with collect=false skips settle wait and forced collection", async () => {
  let ensureCalled = 0;
  let invoiceCalled = 0;
  let sleepCalled = 0;
  let capturedRequestId = "";
  let capturedNetworkFeeUsdMicros = "";

  const result = await ingestTestUsageEvent(
    {
      publicClientId: "pc_123",
      externalUserId: "eu_123",
      amountUsd: "12.34",
      collect: false,
    },
    createDeps({
      ensureOpenMeterCustomerForAppUser: async () => {
        ensureCalled += 1;
        return {
          id: "customer_1",
          key: "pc_123:eu_123",
        };
      },
      ingestSignedTicketEvent: async (input) => {
        capturedRequestId = input.event.requestId;
        capturedNetworkFeeUsdMicros = input.event.networkFeeUsdMicros;
      },
      invoiceGatheringForIdentity: async () => {
        invoiceCalled += 1;
        return { outcome: "invoiced", invoiceIds: ["inv_1"] };
      },
      sleep: async () => {
        sleepCalled += 1;
      },
    }),
  );

  assert.equal(ensureCalled, 1);
  assert.equal(invoiceCalled, 0);
  assert.equal(sleepCalled, 0);
  assert.equal(
    capturedRequestId,
    "test-usage-11111111-1111-4111-8111-111111111111",
  );
  assert.equal(capturedNetworkFeeUsdMicros, "12340000");
  assert.deepEqual(result, {
    requestId: "test-usage-11111111-1111-4111-8111-111111111111",
    amountUsdMicros: "12340000",
    amountUsd: "usd:12340000",
    subject: "pc_123:eu_123",
    collected: false,
  });
});

test("ingestTestUsageEvent defaults collect=true and forces collection after settle wait", async () => {
  let sleptForMs = 0;
  let collectInput: Record<string, unknown> | null = null;

  const result = await ingestTestUsageEvent(
    {
      publicClientId: "pc_123",
      externalUserId: "eu_123",
      amountUsd: "12.34",
    },
    createDeps({
      sleep: async (ms) => {
        sleptForMs = ms;
      },
      invoiceGatheringForIdentity: async (input) => {
        collectInput = input as unknown as Record<string, unknown>;
        return { outcome: "invoiced", invoiceIds: ["inv_9"] };
      },
    }),
  );

  assert.equal(sleptForMs, 2_500);
  assert.deepEqual(collectInput, {
    clientId: "pc_123",
    externalUserId: "eu_123",
    force: true,
  });
  assert.equal(result.collected, true);
  assert.deepEqual(result.collect, {
    outcome: "invoiced",
    invoiceIds: ["inv_9"],
  });
});
