import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { eq } from "drizzle-orm";

import { db } from "@/db/index";
import { oidcClients } from "@/db/schema";
import { issueProgrammaticTokens } from "@/lib/oidc/programmatic-tokens";
import { upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import {
  BILLING_SUBJECT_KEY_CLAIM,
  COST_OWNER_USER_ID_CLAIM,
  resetBillingIdentityCache,
} from "@/lib/openmeter/billing-identity";
import { buildOwnerCustomerKey, isEndUserCustomerKey } from "@/lib/openmeter/customer-key";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createAppUser,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";

test("programmatic JWT mint follows owner_rollup then merchant billing_mode", async (t) => {
  const app = await seedDeveloperAppWithClient({ status: "approved" });
  t.after(() => cleanupTestApp(app));

  await db
    .update(oidcClients)
    .set({ allowedScopes: "openid sign:job users:token" })
    .where(eq(oidcClients.id, app.oidcClientRowId));

  const externalUserId = `ext-${randomUUID()}`;
  const appUser = await createAppUser({
    clientId: app.clientId,
    externalUserId,
  });

  await upsertAppBillingConfig(app.clientId, { billingMode: "owner_rollup" });
  resetBillingIdentityCache();
  const rollup = await issueProgrammaticTokens({
    developerAppId: app.clientId,
    oauthClientId: app.clientId,
    appUserId: appUser.id,
    scopes: ["openid"],
  });
  const rollupClaims = decodeJwt(rollup.access_token);
  assert.equal(rollupClaims.user_type, "app_user");
  assert.equal(
    rollupClaims[BILLING_SUBJECT_KEY_CLAIM],
    buildOwnerCustomerKey(app.userId),
  );
  assert.equal(rollupClaims[COST_OWNER_USER_ID_CLAIM], app.userId);

  await upsertAppBillingConfig(app.clientId, {
    billingMode: "merchant",
    stripeLivemode: true,
  });
  resetBillingIdentityCache();
  const merchant = await issueProgrammaticTokens({
    developerAppId: app.clientId,
    oauthClientId: app.clientId,
    appUserId: appUser.id,
    scopes: ["openid"],
  });
  const merchantClaims = decodeJwt(merchant.access_token);
  assert.equal(merchantClaims.user_type, "app_user");
  assert.equal(merchantClaims[COST_OWNER_USER_ID_CLAIM], undefined);
  assert.ok(
    isEndUserCustomerKey(String(merchantClaims[BILLING_SUBJECT_KEY_CLAIM])),
  );
  assert.notEqual(
    merchantClaims[BILLING_SUBJECT_KEY_CLAIM],
    buildOwnerCustomerKey(app.userId),
  );
});
