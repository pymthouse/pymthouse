import assert from "node:assert/strict";

import { run } from "@/test-utils/db-guard";

run("signer proxy routes return 410 Gone", async () => {
  const { POST: signOrchestratorInfo } = await import("./sign-orchestrator-info/route");
  const { POST: signByocJob } = await import("./sign-byoc-job/route");
  const { GET: discoverOrchestrators } = await import("./discover-orchestrators/route");
  const { POST: generateLivePayment } = await import("./generate-live-payment/route");

  for (const handler of [
    signOrchestratorInfo,
    signByocJob,
    generateLivePayment,
  ]) {
    const response = await handler();
    assert.equal(response.status, 410);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "signer_proxy_deprecated");
  }

  const discoverResponse = await discoverOrchestrators();
  assert.equal(discoverResponse.status, 410);
  const discoverBody = (await discoverResponse.json()) as { error: string };
  assert.equal(discoverBody.error, "signer_proxy_deprecated");
});
