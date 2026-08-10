import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nodeTest from "node:test";

import {
  AppUserOwnerWalletMutationError,
  assertAppUserRetailBillingSubject,
  rejectOwnerWireRetailSubject,
  resetBillingIdentityCacheForTests,
  resolveOpenMeterBillingIdentity,
} from "@/lib/openmeter/billing-identity";
import {
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
} from "@/lib/openmeter/customer-key";
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
    assert.equal(identity.ownerUserId, seeded.userId);
    assert.equal(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
  });
});

test("normal app end-user stays on compound customer", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const endUserId = `ext-${randomUUID()}`;

  resetBillingIdentityCacheForTests();
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: seeded.clientId,
    externalUserId: endUserId,
  });
  assert.equal(identity.isOwner, false);
  assert.equal(identity.ownerUserId, undefined);
  assert.equal(
    identity.customerKey,
    buildOpenMeterCustomerKey(seeded.clientId, endUserId),
  );
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
  assert.equal(identity.ownerUserId, seeded.userId);
  assert.equal(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
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
