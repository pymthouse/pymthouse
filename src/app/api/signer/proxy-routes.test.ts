import assert from "node:assert/strict";

import { run } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createJobTokenForApp,
  createTestUserWithCleanup,
  ensureRunningSigner,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { mockSignerFetch } from "@/test-utils/mock-signer";
import { buildOrchestratorInfoBase64 } from "@/test-utils/orchestrator-info";

/**
 * Coverage for the remaining signer proxy routes: confirms scope/auth
 * enforcement and that successful calls are forwarded to the mocked signer.
 */
run("signer proxy routes enforce auth and forward to the signer", async (t) => {
  const { POST: signOrchestratorInfo } = await import("./sign-orchestrator-info/route");
  const { POST: signByocJob } = await import("./sign-byoc-job/route");
  const { GET: discoverOrchestrators } = await import("./discover-orchestrators/route");
  const { POST: generateLivePayment } = await import("./generate-live-payment/route");

  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  const jobToken = await createJobTokenForApp({
    userId: app.userId,
    clientId: app.clientId,
    scopes: "sign:job",
  });

  const wrongScopeToken = await createJobTokenForApp({
    userId: app.userId,
    clientId: app.clientId,
    scopes: "openid",
  });

  const mock = mockSignerFetch();
  t.after(mock.restore);

  // Each POST route rejects without Authorization.
  for (const [route, url] of [
    [signOrchestratorInfo, "http://localhost/api/signer/sign-orchestrator-info"],
    [signByocJob, "http://localhost/api/signer/sign-byoc-job"],
    [generateLivePayment, "http://localhost/api/signer/generate-live-payment"],
  ] as const) {
    const res = await route(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }) as never,
    );
    assert.equal(res.status, 401, `${url} without auth returns 401`);
  }

  const discoverNoAuth = await discoverOrchestrators(
    new Request("http://localhost/api/signer/discover-orchestrators") as never,
  );
  assert.equal(discoverNoAuth.status, 401);

  // Missing sign:job scope -> 403.
  const forbidden = await signOrchestratorInfo(
    new Request("http://localhost/api/signer/sign-orchestrator-info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${wrongScopeToken}`,
      },
      body: "{}",
    }) as never,
  );
  assert.equal(forbidden.status, 403);

  // Happy path for each: routes forward to mocked signer and surface its body.
  const siRes = await signOrchestratorInfo(
    new Request("http://localhost/api/signer/sign-orchestrator-info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jobToken}`,
      },
      body: JSON.stringify({ manifestId: "abc" }),
    }) as never,
  );
  assert.equal(siRes.status, 200);
  const siBody = (await siRes.json()) as { signedData: string };
  assert.equal(siBody.signedData, "mock-signed");

  const byocRes = await signByocJob(
    new Request("http://localhost/api/signer/sign-byoc-job", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jobToken}`,
      },
      body: JSON.stringify({ job: "xyz", pipeline: "text-to-image" }),
    }) as never,
  );
  assert.equal(byocRes.status, 200);
  const byocBody = (await byocRes.json()) as { signedJob: string };
  assert.equal(byocBody.signedJob, "mock-signed");

  const discoverRes = await discoverOrchestrators(
    new Request("http://localhost/api/signer/discover-orchestrators", {
      method: "GET",
      headers: { Authorization: `Bearer ${jobToken}` },
    }) as never,
  );
  assert.equal(discoverRes.status, 200);
  const discoverBody = (await discoverRes.json()) as { orchestrators: unknown[] };
  assert.ok(Array.isArray(discoverBody.orchestrators));

  // Confirm every call above went to the mocked signer host.
  const expectedSignerOrigin = new URL("https://test-signer.invalid").origin;
  assert.ok(
    mock.calls.every((c) => {
      try {
        return new URL(c.url).origin === expectedSignerOrigin;
      } catch {
        return false;
      }
    }),
  );
});

run("generate-live-payment rejects requests against unapproved apps", async (t) => {
  const { POST: generateLivePayment } = await import("./generate-live-payment/route");

  const restoreSigner = await ensureRunningSigner();
  t.after(restoreSigner);

  const app = await seedDeveloperAppWithClient({ status: "draft" });
  t.after(() => cleanupTestApp(app));

  const strangerUserId = await createTestUserWithCleanup(t);

  const strangerToken = await createJobTokenForApp({
    userId: strangerUserId,
    clientId: app.clientId,
    scopes: "sign:job",
  });

  const orch = await buildOrchestratorInfoBase64({
    pricePerUnit: 100,
    pixelsPerUnit: 1,
  });

  const mock = mockSignerFetch();
  t.after(mock.restore);

  const res = await generateLivePayment(
    new Request("http://localhost/api/signer/generate-live-payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${strangerToken}`,
      },
      body: JSON.stringify({
        ManifestID: "m1",
        RequestID: "r1",
        InPixels: 100,
        Orchestrator: orch,
      }),
    }) as never,
  );
  assert.equal(res.status, 403, "non-owner tokens on unapproved apps return 403");
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "app_not_approved");
  assert.equal(
    mock.calls.length,
    0,
    "approval check happens before any signer forwarding",
  );
});
