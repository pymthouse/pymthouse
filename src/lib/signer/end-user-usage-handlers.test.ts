import assert from "node:assert/strict";
import test from "node:test";

import {
  __testClearOpenMeterUsageStubs,
  __testSetOpenMeterDailyPipelineRows,
  __testSetOpenMeterUsageRows,
} from "@/lib/openmeter/usage-read";
import { resolveExternalUserIdForUsage } from "@/lib/signer/end-user-identity-config";
import { readUsage } from "@/lib/signer/end-user-usage-handlers";

test("resolveExternalUserIdForUsage returns usage_subject for external users", async () => {
  const externalUserId = await resolveExternalUserIdForUsage({
    identity: {
      issuer: "https://auth.test",
      client_id: "app_1",
      usage_subject: "user@example.com",
      usage_subject_type: "external_user_id",
    },
    expiry: 4_102_444_800,
    raw: {
      user_type: "external_user",
      __subjectAccessToken: "unused-token",
    },
  });
  assert.equal(externalUserId, "user@example.com");
});

test("readUsage returns self-scoped usage summary from OpenMeter stubs", async (t) => {
  const clientId = "app_test_me_usage";
  __testSetOpenMeterUsageRows(clientId, [
    {
      externalUserId: "alpha-ext",
      requestCount: 3,
      networkFeeUsdMicros: "6000000",
    },
  ]);
  __testSetOpenMeterDailyPipelineRows(clientId, [
    {
      pipeline: "text-to-image",
      modelId: "stabilityai/sdxl",
      date: "2026-06-02",
      requestCount: 2,
      networkFeeUsdMicros: "4000000",
    },
    {
      pipeline: "llm",
      modelId: "openai-chat-completions",
      date: "2026-06-03",
      requestCount: 1,
      networkFeeUsdMicros: "2000000",
    },
  ]);
  t.after(() => __testClearOpenMeterUsageStubs());

  const summary = await readUsage({
    clientId,
    externalUserId: "alpha-ext",
  });

  assert.equal(summary.clientId, clientId);
  assert.equal(summary.currentUser.externalUserId, "alpha-ext");
  assert.equal(summary.currentUser.requestCount, 3);
  assert.equal(summary.currentUser.networkFeeUsdMicros, "6000000");
  assert.ok(summary.currentUser.pipelineModels.length >= 1);
  assert.equal(summary.currentUser.dailyByPipeline?.length, 2);
});

test("readUsage rejects invalid startDate", async () => {
  await assert.rejects(
    () =>
      readUsage({
        clientId: "app_1",
        externalUserId: "user-1",
        startDate: "not-a-date",
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Invalid startDate/);
      return true;
    },
  );
});
