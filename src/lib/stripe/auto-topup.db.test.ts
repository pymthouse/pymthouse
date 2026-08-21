import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { appUsers } from "@/db/schema";
import {
  findOrCreateAppEndUser,
  resolveAppUserExternalIdFromCustomerKey,
} from "@/lib/billing/end-users";
import {
  buildEndUserCustomerKey,
  buildSandboxEndUserCustomerKey,
} from "@/lib/openmeter/customer-key";
import {
  loadAppUserAutoTopUpPrefs,
  saveAppUserAutoTopUpPrefs,
} from "@/lib/stripe/auto-topup";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

test("loadAppUserAutoTopUpPrefs returns disabled when no app user row exists", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `AutoTopUp ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  assert.deepEqual(
    await loadAppUserAutoTopUpPrefs({
      appId: app.clientId,
      externalUserId: "missing-user",
    }),
    { enabled: false, amountUsd: null },
  );
});

test("saveAppUserAutoTopUpPrefs upserts the app user and persists prefs", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `AutoTopUp ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });
  const externalUserId = `eu_${randomUUID()}`;

  const saved = await saveAppUserAutoTopUpPrefs({
    appId: app.clientId,
    externalUserId,
    enabled: true,
    amountUsdMicros: 25_000_000n,
  });
  assert.deepEqual(saved, { enabled: true, amountUsd: "25.00" });
  assert.deepEqual(
    await loadAppUserAutoTopUpPrefs({
      appId: app.clientId,
      externalUserId,
    }),
    { enabled: true, amountUsd: "25.00" },
  );

  const disabled = await saveAppUserAutoTopUpPrefs({
    appId: app.clientId,
    externalUserId,
    enabled: false,
    amountUsdMicros: 10_000_000n,
  });
  assert.deepEqual(disabled, { enabled: false, amountUsd: "10.00" });

  const rows = await db
    .select({
      autoTopUpEnabled: appUsers.autoTopUpEnabled,
      autoTopUpUsdMicros: appUsers.autoTopUpUsdMicros,
    })
    .from(appUsers)
    .where(eq(appUsers.clientId, app.clientId))
    .limit(1);
  assert.deepEqual(rows[0], {
    autoTopUpEnabled: false,
    autoTopUpUsdMicros: "10000000",
  });
});

test("resolveAppUserExternalIdFromCustomerKey maps eu_ keys to the integrator id", async (t) => {
  const app = await seedDeveloperAppWithClient({
    name: `AutoTopUp ${randomUUID().slice(0, 8)}`,
  });
  t.after(async () => {
    await cleanupTestApp(app);
  });
  const externalUserId = `comfy-${randomUUID()}`;
  const created = await findOrCreateAppEndUser(app.clientId, externalUserId);
  const customerKey = buildEndUserCustomerKey(created.id);

  assert.equal(
    await resolveAppUserExternalIdFromCustomerKey(customerKey),
    externalUserId,
  );
  assert.equal(
    await resolveAppUserExternalIdFromCustomerKey(
      buildSandboxEndUserCustomerKey(created.id),
    ),
    externalUserId,
  );
  assert.equal(
    await resolveAppUserExternalIdFromCustomerKey(externalUserId),
    externalUserId,
  );
  assert.equal(
    await resolveAppUserExternalIdFromCustomerKey("eu_missing-row"),
    "eu_missing-row",
  );
});
