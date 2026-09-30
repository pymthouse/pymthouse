import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "@/db/index";
import { appAllowedDomains } from "@/db/schema";
import { test } from "@/test-utils/db-guard";
import { cleanupTestApp, seedDeveloperAppWithClient } from "@/test-utils/fixtures";

import { getIssuer } from "./issuer-urls";
import { getProvider, resetProvider } from "./provider";

test("getProvider single-flights init and resetProvider rebuilds the instance", async (t) => {
  const firstApp = await seedDeveloperAppWithClient({ name: "CORS App A" });
  const secondApp = await seedDeveloperAppWithClient({ name: "CORS App B" });
  t.after(async () => {
    resetProvider();
    await cleanupTestApp(firstApp);
    await cleanupTestApp(secondApp);
  });

  await db.insert(appAllowedDomains).values([
    {
      id: randomUUID(),
      appId: firstApp.clientId,
      domain: "https://a.example",
    },
    {
      id: randomUUID(),
      appId: firstApp.clientId,
      domain: "https://b.example",
    },
    {
      id: randomUUID(),
      appId: secondApp.clientId,
      domain: "https://c.example",
    },
  ]);

  resetProvider();
  const [first, second] = await Promise.all([getProvider(), getProvider()]);
  assert.equal(first, second);
  assert.equal(first.issuer, getIssuer());

  const cached = await getProvider();
  assert.equal(cached, first);

  resetProvider();
  const rebuilt = await getProvider();
  assert.notEqual(rebuilt, first);
  assert.equal(rebuilt.issuer, getIssuer());
});
