import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { resolveWalletBillingTarget } from "@/lib/billing/wallet-billing-target";
import { upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

test("merchant wallet target rejects owner: wire subjects", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  await upsertAppBillingConfig(seeded.clientId, { billingMode: "merchant" });

  const result = await resolveWalletBillingTarget({
    appId: seeded.clientId,
    ownerUserId: seeded.userId,
    externalUserId: `owner:${randomUUID()}`,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /owner:\{users\.id\}/);
  }
});

test("merchant wallet target accepts ordinary end-user ids", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  await upsertAppBillingConfig(seeded.clientId, { billingMode: "merchant" });

  const externalUserId = `eu_${randomUUID()}`;
  const result = await resolveWalletBillingTarget({
    appId: seeded.clientId,
    ownerUserId: seeded.userId,
    externalUserId,
  });
  assert.deepEqual(result, {
    ok: true,
    target: { mode: "merchant", externalUserId },
  });
});
