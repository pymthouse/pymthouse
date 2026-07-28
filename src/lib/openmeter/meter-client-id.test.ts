import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { developerApps, oidcClients, users } from "@/db/schema";
import { resolveOpenMeterMeterClientId } from "@/lib/openmeter/meter-client-id";
import { test } from "@/test-utils/db-guard";
import { createTestUser } from "@/test-utils/fixtures";

test("resolveOpenMeterMeterClientId returns empty input unchanged", async () => {
  assert.equal(await resolveOpenMeterMeterClientId(""), "");
  assert.equal(await resolveOpenMeterMeterClientId("   "), "");
});

test("resolveOpenMeterMeterClientId passthrough for public app_ ids", async () => {
  assert.equal(
    await resolveOpenMeterMeterClientId("app_aaaaaaaaaaaaaaaaaaaaaaaa"),
    "app_aaaaaaaaaaaaaaaaaaaaaaaa",
  );
});

test("resolveOpenMeterMeterClientId returns unknown ids unchanged", async () => {
  const unknown = randomUUID();
  assert.equal(await resolveOpenMeterMeterClientId(unknown), unknown);
});

test("resolveOpenMeterMeterClientId maps developer_apps.id to public client id", async (t) => {
  const ownerId = await createTestUser();
  const publicClientId = `app_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const internalAppId = randomUUID();
  const oidcRowId = randomUUID();
  const now = new Date().toISOString();

  await db.insert(oidcClients).values({
    id: oidcRowId,
    clientId: publicClientId,
    clientSecretHash: null,
    displayName: "meter-client-id-test",
    redirectUris: "[]",
    allowedScopes: "openid",
    grantTypes: "refresh_token",
    tokenEndpointAuthMethod: "none",
    createdAt: now,
  });
  await db.insert(developerApps).values({
    id: internalAppId,
    ownerId,
    oidcClientId: oidcRowId,
    name: "meter-client-id-test",
    status: "approved",
    createdAt: now,
    updatedAt: now,
  });

  t.after(async () => {
    await db.delete(developerApps).where(eq(developerApps.id, internalAppId));
    await db.delete(oidcClients).where(eq(oidcClients.id, oidcRowId));
    await db.delete(users).where(eq(users.id, ownerId));
  });

  assert.equal(await resolveOpenMeterMeterClientId(internalAppId), publicClientId);
});
