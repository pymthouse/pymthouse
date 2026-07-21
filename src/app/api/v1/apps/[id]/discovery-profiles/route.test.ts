import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";

import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { discoveryProfileBundles, discoveryProfiles, plans } from "@/db/schema";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";
import {
  installProviderAppSessionAuth,
  uninstallProviderAppSessionAuth,
} from "@/test-utils/provider-app-session-auth";

let authorizedApp: SeededDeveloperApp | null = null;

installProviderAppSessionAuth(() => authorizedApp);

test.after(() => {
  uninstallProviderAppSessionAuth();
});

test("discovery-profiles POST GET and DELETE", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  authorizedApp = app;
  t.after(async () => {
    authorizedApp = null;
    await cleanupTestApp(app);
  });

  const { POST: postCollection, GET: getCollection } = await import("./route");
  const { DELETE: deleteOne } = await import("./[profileId]/route");

  const postRes = await postCollection(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/discovery-profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Profile A",
        policy: { topN: 8, sortBy: "price" },
        capabilities: [
          { pipeline: "vid", modelId: "*", discoveryPolicy: { topN: 2 } },
        ],
      }),
    }) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(postRes.status, 201);
  const postBody = (await postRes.json()) as { id: string };
  const profileId = postBody.id;
  assert.equal(typeof profileId, "string");

  const getRes = await getCollection(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/discovery-profiles`) as never,
    { params: Promise.resolve({ id: app.clientId }) },
  );
  assert.equal(getRes.status, 200);
  const list = (await getRes.json()) as {
    profiles: Array<{ id: string; name: string }>;
  };
  assert.ok(list.profiles.some((p) => p.id === profileId));

  await db.insert(plans).values({
    id: randomUUID(),
    clientId: app.clientId,
    name: "Uses profile",
    type: "free",
    status: "active",
    discoveryProfileId: profileId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const delBlocked = await deleteOne(
    new Request(`http://localhost/`) as never,
    { params: Promise.resolve({ id: app.clientId, profileId }) },
  );
  assert.equal(delBlocked.status, 409);

  await db.delete(plans).where(eq(plans.discoveryProfileId, profileId));

  const delOk = await deleteOne(
    new Request(`http://localhost/`) as never,
    { params: Promise.resolve({ id: app.clientId, profileId }) },
  );
  assert.equal(delOk.status, 200);

  const rows = await db.select().from(discoveryProfiles).where(eq(discoveryProfiles.id, profileId));
  assert.equal(rows.length, 0);
  const bundles = await db
    .select()
    .from(discoveryProfileBundles)
    .where(eq(discoveryProfileBundles.profileId, profileId));
  assert.equal(bundles.length, 0);
});
