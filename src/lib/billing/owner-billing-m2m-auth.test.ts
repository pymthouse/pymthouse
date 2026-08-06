import assert from "node:assert/strict";

import { authorizeOwnerBillingM2m } from "@/lib/billing/owner-billing-m2m-auth";
import { test } from "@/test-utils/db-guard";
import {
  basicAuthHeader,
  cleanupTestApp,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

test("authorizeOwnerBillingM2m accepts matching Basic credentials", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

  const auth = await authorizeOwnerBillingM2m(
    new Request(`http://localhost/api/v1/apps/${app.clientId}/billing/tiers`, {
      headers: {
        Authorization: basicAuthHeader(app.clientId, app.clientSecret),
      },
    }),
    app.clientId,
  );
  assert.ok(auth);
  assert.equal(auth!.app.id, app.clientId);
  assert.equal(auth!.ownerUserId, app.userId);
});

test("authorizeOwnerBillingM2m rejects session-less / wrong client", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(async () => {
    await cleanupTestApp(app);
  });

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
          Authorization: basicAuthHeader(app.clientId, app.clientSecret),
        },
      }),
      "app_not_this_one",
    ),
    null,
  );
});