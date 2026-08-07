import assert from "node:assert/strict";

import { authorizeOwnerBillingM2m } from "@/lib/billing/owner-billing-m2m-auth";
import {
  ensureConfidentialWebClient,
  ensureM2mBackendClient,
  removeConfidentialWebClient,
  removeM2mBackendClient,
  rotateClientSecret,
} from "@/lib/oidc/clients";
import { test } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  seedDeveloperAppWithClient,
  type SeededDeveloperApp,
} from "@/test-utils/fixtures";

async function seedOwnerBillingM2mApp(t: {
  after: (fn: () => Promise<void>) => void;
}): Promise<
  SeededDeveloperApp & {
    m2mClientId: string;
    m2mClientSecret: string;
    webClientId: string;
    webClientSecret: string;
  }
> {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  const m2m = await ensureM2mBackendClient({
    appInternalId: app.clientId,
    appDisplayName: "Owner Billing M2M",
  });
  assert.ok(m2m);
  const m2mClientSecret = await rotateClientSecret(m2m.clientId);
  assert.ok(m2mClientSecret);
  const web = await ensureConfidentialWebClient({
    appInternalId: app.clientId,
    appDisplayName: "Owner Billing Web",
    redirectUris: ["https://portal.example.com/cb"],
  });
  assert.ok(web);
  const webClientSecret = await rotateClientSecret(web.clientId);
  assert.ok(webClientSecret);
  t.after(async () => {
    await removeConfidentialWebClient(app.clientId).catch(() => undefined);
    await removeM2mBackendClient(app.clientId).catch(() => undefined);
    await cleanupTestApp(app);
  });
  return {
    ...app,
    m2mClientId: m2m.clientId,
    m2mClientSecret,
    webClientId: web.clientId,
    webClientSecret,
  };
}

test("authorizeOwnerBillingM2m accepts matching M2M Basic credentials", async (t) => {
  const app = await seedOwnerBillingM2mApp(t);

  const auth = await authorizeOwnerBillingM2m(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/billing/tiers`, {
      headers: {
        Authorization: basicAuthHeader(app.m2mClientId, app.m2mClientSecret),
      },
    }),
    app.clientId,
  );
  assert.ok(auth);
  assert.equal(auth!.app.id, app.clientId);
  assert.equal(auth!.ownerUserId, app.userId);
});

test("authorizeOwnerBillingM2m rejects another valid client for the same app", async (t) => {
  const app = await seedOwnerBillingM2mApp(t);

  assert.equal(
    await authorizeOwnerBillingM2m(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/billing/tiers`, {
        headers: {
          Authorization: basicAuthHeader(app.webClientId, app.webClientSecret),
        },
      }),
      app.clientId,
    ),
    null,
  );
});

test("authorizeOwnerBillingM2m rejects session-less / wrong client", async (t) => {
  const app = await seedOwnerBillingM2mApp(t);

  assert.equal(
    await authorizeOwnerBillingM2m(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/billing/tiers`),
      app.clientId,
    ),
    null,
  );

  assert.equal(
    await authorizeOwnerBillingM2m(
      new Request(`http://localhost/api/v1/apps/${app.clientId}/billing/tiers`, {
        headers: {
          Authorization: basicAuthHeader(app.m2mClientId, app.m2mClientSecret),
        },
      }),
      "app_not_this_one",
    ),
    null,
  );
});
