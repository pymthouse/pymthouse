import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nodeTest from "node:test";

import {
  AppUserOwnerWalletMutationError,
  assertAppUserRetailBillingSubject,
  costOwnerUserIdClaim,
  ownerCostRailUserId,
  ownerWireUsageSubjectFromJwt,
  rejectOwnerWireRetailSubject,
  resetBillingIdentityCacheForTests,
  resolveOpenMeterBillingIdentity,
  signerBalanceGateSubject,
} from "@/lib/openmeter/billing-identity";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
} from "@/lib/openmeter/customer-key";
import { upsertAppBillingConfig } from "@/lib/openmeter/billing-profiles";
import { test } from "@/test-utils/db-guard";
import {
  cleanupTestApp,
  createTestUserWithCleanup,
  seedDeveloperAppWithClient,
} from "@/test-utils/fixtures";
import { withTemporaryPlatformDefault } from "@/test-utils/platform-default-lock";

nodeTest("rejectOwnerWireRetailSubject rejects owner: subjects only", () => {
  assert.throws(
    () => rejectOwnerWireRetailSubject("owner:user-1"),
    (err: unknown) =>
      err instanceof AppUserOwnerWalletMutationError &&
      err.code === "owner_wallet_not_app_user",
  );
  rejectOwnerWireRetailSubject("user-1");
  rejectOwnerWireRetailSubject("ext-abc");
});

nodeTest("ownerWireUsageSubjectFromJwt prefers cost_owner_user_id over user_type", () => {
  const rewritten = ownerWireUsageSubjectFromJwt({
    userType: "external_user",
    usageSubject: "ext-9",
    costOwnerUserId: "owner-uuid",
  });
  assert.equal(rewritten.usageSubject, buildOwnerWireSubject("owner-uuid"));
  assert.equal(rewritten.usageSubjectType, "app_owner");
  assert.notEqual(rewritten.usageSubject, buildOwnerWireSubject("ext-9"));
});

nodeTest("ownerWireUsageSubjectFromJwt leaves merchant end-users on the actor id", () => {
  const rewritten = ownerWireUsageSubjectFromJwt({
    userType: "app_user",
    usageSubject: "ext-9",
  });
  assert.equal(rewritten.usageSubject, "ext-9");
  assert.equal(rewritten.usageSubjectType, "external_user_id");
});

test("platform-default member bills their own owner wallet", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const memberId = await createTestUserWithCleanup(t);

  resetBillingIdentityCacheForTests();
  await withTemporaryPlatformDefault(seeded.clientId, async () => {
    resetBillingIdentityCacheForTests();
    const identity = await resolveOpenMeterBillingIdentity({
      clientId: seeded.clientId,
      externalUserId: memberId,
    });
    assert.equal(identity.isOwner, true);
    assert.equal(identity.sharesOwnerCostRail, true);
    assert.equal(identity.ownerUserId, memberId);
    assert.equal(identity.customerKey, buildOwnerCustomerKey(memberId));
    assert.notEqual(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
    assert.equal(identity.publicClientId, seeded.clientId);
  });
});

test("platform-default admin owner still bills own wallet", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  resetBillingIdentityCacheForTests();
  await withTemporaryPlatformDefault(seeded.clientId, async () => {
    resetBillingIdentityCacheForTests();
    const identity = await resolveOpenMeterBillingIdentity({
      clientId: seeded.clientId,
      externalUserId: seeded.userId,
    });
    assert.equal(identity.isOwner, true);
    assert.equal(identity.sharesOwnerCostRail, true);
    assert.equal(identity.ownerUserId, seeded.userId);
    assert.equal(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
  });
});

test("owner_rollup end-user shares the owner wallet", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const endUserId = `ext-${randomUUID()}`;

  resetBillingIdentityCacheForTests();
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: seeded.clientId,
    externalUserId: endUserId,
  });
  assert.equal(identity.isOwner, false);
  assert.equal(identity.sharesOwnerCostRail, true);
  assert.equal(ownerCostRailUserId(identity), seeded.userId);
  assert.equal(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
  assert.deepEqual(costOwnerUserIdClaim(identity), {
    cost_owner_user_id: seeded.userId,
  });
  assert.equal(
    signerBalanceGateSubject(identity, endUserId),
    `owner:${seeded.userId}`,
  );
});

test("merchant end-user stays on compound customer", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const endUserId = `ext-${randomUUID()}`;

  await upsertAppBillingConfig(seeded.clientId, { billingMode: "merchant" });
  resetBillingIdentityCacheForTests();
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: seeded.clientId,
    externalUserId: endUserId,
  });
  assert.equal(identity.isOwner, false);
  assert.equal(identity.sharesOwnerCostRail, false);
  assert.equal(identity.ownerUserId, undefined);
  assert.equal(
    identity.customerKey,
    buildOpenMeterCustomerKey(seeded.clientId, endUserId),
  );
  assert.deepEqual(costOwnerUserIdClaim(identity), {});
  assert.equal(signerBalanceGateSubject(identity, endUserId), endUserId);
});

test("normal app owner bills shared owner wallet", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  resetBillingIdentityCacheForTests();
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: seeded.clientId,
    externalUserId: seeded.userId,
  });
  assert.equal(identity.isOwner, true);
  assert.equal(identity.sharesOwnerCostRail, true);
  assert.equal(identity.ownerUserId, seeded.userId);
  assert.equal(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
  assert.deepEqual(costOwnerUserIdClaim(identity), {});
});

test("assertAppUserRetailBillingSubject rejects owner wallet targets", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const endUserId = `ext-${randomUUID()}`;

  resetBillingIdentityCacheForTests();
  await assert.rejects(
    () =>
      assertAppUserRetailBillingSubject({
        clientId: seeded.clientId,
        externalUserId: seeded.userId,
      }),
    (err: unknown) =>
      err instanceof AppUserOwnerWalletMutationError &&
      err.code === "owner_wallet_not_app_user",
  );
  await assert.rejects(
    () =>
      assertAppUserRetailBillingSubject({
        clientId: seeded.clientId,
        externalUserId: `owner:${seeded.userId}`,
      }),
    (err: unknown) => err instanceof AppUserOwnerWalletMutationError,
  );
  await assert.rejects(
    () =>
      assertAppUserRetailBillingSubject({
        clientId: seeded.clientId,
        externalUserId: endUserId,
      }),
    (err: unknown) => err instanceof AppUserOwnerWalletMutationError,
  );
});

test("assertAppUserRetailBillingSubject allows merchant end-users", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const endUserId = `ext-${randomUUID()}`;

  await upsertAppBillingConfig(seeded.clientId, { billingMode: "merchant" });
  resetBillingIdentityCacheForTests();
  await assertAppUserRetailBillingSubject({
    clientId: seeded.clientId,
    externalUserId: endUserId,
  });
});

test("assertAppUserRetailBillingSubject rejects platform-default members", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const memberId = await createTestUserWithCleanup(t);

  resetBillingIdentityCacheForTests();
  await withTemporaryPlatformDefault(seeded.clientId, async () => {
    resetBillingIdentityCacheForTests();
    await assert.rejects(
      () =>
        assertAppUserRetailBillingSubject({
          clientId: seeded.clientId,
          externalUserId: memberId,
        }),
      (err: unknown) => err instanceof AppUserOwnerWalletMutationError,
    );
  });
});
