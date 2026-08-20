import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nodeTest from "node:test";

import {
  appUserRetailCustomerKey,
  AppUserOwnerWalletMutationError,
  assertAppUserRetailBillingSubject,
  billingSubjectClaim,
  buildPayerActorWireSubject,
  costOwnerUserIdClaim,
  ownerCostRailUserId,
  parsePayerActorWireSubject,
  rejectOwnerWireRetailSubject,
  resetBillingIdentityCache,
  resolveOpenMeterBillingIdentity,
  signerBalanceGateSubject,
  signerSpendableCacheSubject,
  signerSpendableLookupSubject,
  wireUsageSubjectFromJwt,
} from "@/lib/openmeter/billing-identity";
import {
  buildEndUserCustomerKey,
  buildOpenMeterCustomerKey,
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
  buildSandboxEndUserCustomerKey,
  isEndUserCustomerKey,
  isSandboxEndUserCustomerKey,
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

nodeTest("appUserRetailCustomerKey keeps end-user cards off the owner wallet", () => {
  assert.equal(
    appUserRetailCustomerKey({
      customerKey: "owner-uuid",
      payerCustomerKey: "owner-uuid",
      payerKind: "platform_user",
      isOwner: false,
      sharesOwnerCostRail: true,
      actorEndUserId: "eu_end-user-1",
      actorExternalUserId: "ext-9",
      publicClientId: "app_demo",
      developerAppId: "app_demo",
    }),
    "eu_end-user-1",
  );
  assert.equal(
    appUserRetailCustomerKey({
      customerKey: "eu_end-user-1",
      payerCustomerKey: "eu_end-user-1",
      payerKind: "end_user",
      isOwner: false,
      sharesOwnerCostRail: false,
      actorEndUserId: "eu_end-user-1",
      actorExternalUserId: "ext-9",
      publicClientId: "app_demo",
      developerAppId: "app_demo",
    }),
    "eu_end-user-1",
  );
  assert.equal(
    appUserRetailCustomerKey({
      customerKey: "sbx_eu_end-user-1",
      payerCustomerKey: "sbx_eu_end-user-1",
      payerKind: "end_user",
      isOwner: false,
      sharesOwnerCostRail: false,
      actorEndUserId: "eu_end-user-1",
      actorExternalUserId: "ext-9",
      publicClientId: "app_demo",
      developerAppId: "app_demo",
    }),
    "sbx_eu_end-user-1",
  );
  assert.equal(
    appUserRetailCustomerKey({
      customerKey: "owner-uuid",
      payerCustomerKey: "owner-uuid",
      payerKind: "platform_user",
      isOwner: true,
      sharesOwnerCostRail: true,
      actorEndUserId: "owner-uuid",
      actorExternalUserId: "owner-uuid",
      publicClientId: "app_demo",
      developerAppId: "app_demo",
    }),
    "owner-uuid",
  );
});

nodeTest("wireUsageSubjectFromJwt prefers cost_owner_user_id over user_type", () => {
  const rewritten = wireUsageSubjectFromJwt({
    userType: "external_user",
    usageSubject: "ext-9",
    costOwnerUserId: "owner-uuid",
  });
  assert.equal(
    rewritten.usageSubject,
    `${buildOwnerWireSubject("owner-uuid")}#ext-9`,
  );
  assert.equal(rewritten.usageSubjectType, "app_owner");
  assert.notEqual(rewritten.usageSubject, buildOwnerWireSubject("ext-9"));
});

nodeTest("wireUsageSubjectFromJwt prefers billing_subject_key", () => {
  const rewritten = wireUsageSubjectFromJwt({
    userType: "external_user",
    usageSubject: "ext-9",
    billingSubjectKey: "eu_end-user-1",
  });
  assert.equal(rewritten.usageSubject, "eu_end-user-1#ext-9");
  assert.equal(rewritten.usageSubjectType, "external_user_id");
});

nodeTest("wireUsageSubjectFromJwt does not owner-prefix compound billing keys", () => {
  const rewritten = wireUsageSubjectFromJwt({
    userType: "external_user",
    usageSubject: "ext-9",
    billingSubjectKey: "app_demo:ext-9",
  });
  assert.equal(rewritten.usageSubject, "app_demo:ext-9#ext-9");
  assert.equal(rewritten.usageSubjectType, "external_user_id");
  assert.ok(!rewritten.usageSubject.startsWith("owner:"));
});

nodeTest("wireUsageSubjectFromJwt leaves merchant end-users on the actor id", () => {
  const rewritten = wireUsageSubjectFromJwt({
    userType: "app_user",
    usageSubject: "ext-9",
  });
  assert.equal(rewritten.usageSubject, "ext-9");
  assert.equal(rewritten.usageSubjectType, "external_user_id");
});

nodeTest("parsePayerActorWireSubject splits payer#actor", () => {
  assert.deepEqual(parsePayerActorWireSubject("owner:abc#ext-9"), {
    payerWire: "owner:abc",
    actorExternalUserId: "ext-9",
  });
  assert.deepEqual(parsePayerActorWireSubject("owner:abc"), {
    payerWire: "owner:abc",
    actorExternalUserId: null,
  });
  assert.equal(
    signerSpendableCacheSubject("eu_payer#eu_actor"),
    "eu_payer",
  );
  assert.equal(
    signerSpendableLookupSubject("eu_payer#eu_actor"),
    "eu_actor",
  );
  assert.equal(signerSpendableLookupSubject("eu_payer"), "eu_payer");
  assert.equal(
    buildPayerActorWireSubject({
      payerCustomerKey: "owner-uuid",
      payerKind: "platform_user",
      actorExternalUserId: "owner-uuid",
    }),
    buildOwnerWireSubject("owner-uuid"),
  );
});

test("platform-default member bills their own owner wallet", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const memberId = await createTestUserWithCleanup(t);

  resetBillingIdentityCache();
  await withTemporaryPlatformDefault(seeded.clientId, async () => {
    resetBillingIdentityCache();
    const identity = await resolveOpenMeterBillingIdentity({
      clientId: seeded.clientId,
      externalUserId: memberId,
    });
    assert.equal(identity.isOwner, true);
    assert.equal(identity.sharesOwnerCostRail, true);
    assert.equal(identity.payerKind, "platform_user");
    assert.equal(identity.payerPlatformUserId, memberId);
    assert.equal(identity.customerKey, buildOwnerCustomerKey(memberId));
    assert.equal(identity.payerCustomerKey, buildOwnerCustomerKey(memberId));
    assert.notEqual(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
    assert.equal(identity.publicClientId, seeded.clientId);
  });
});

test("platform-default admin owner still bills own wallet", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  resetBillingIdentityCache();
  await withTemporaryPlatformDefault(seeded.clientId, async () => {
    resetBillingIdentityCache();
    const identity = await resolveOpenMeterBillingIdentity({
      clientId: seeded.clientId,
      externalUserId: seeded.userId,
    });
    assert.equal(identity.isOwner, true);
    assert.equal(identity.sharesOwnerCostRail, true);
    assert.equal(identity.payerKind, "platform_user");
    assert.equal(identity.payerPlatformUserId, seeded.userId);
    assert.equal(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
  });
});

test("owner_rollup end-user shares the owner wallet with eu_ actor", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const endUserId = `ext-${randomUUID()}`;

  resetBillingIdentityCache();
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: seeded.clientId,
    externalUserId: endUserId,
  });
  assert.equal(identity.isOwner, false);
  assert.equal(identity.sharesOwnerCostRail, true);
  assert.equal(identity.payerKind, "platform_user");
  assert.equal(ownerCostRailUserId(identity), seeded.userId);
  assert.equal(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
  assert.equal(identity.payerCustomerKey, buildOwnerCustomerKey(seeded.userId));
  assert.equal(identity.actorExternalUserId, endUserId);
  assert.ok(isEndUserCustomerKey(identity.actorEndUserId));
  assert.equal(
    identity.legacyCompoundCustomerKey,
    buildOpenMeterCustomerKey(seeded.clientId, endUserId),
  );
  assert.equal(appUserRetailCustomerKey(identity), identity.actorEndUserId);
  assert.notEqual(appUserRetailCustomerKey(identity), identity.customerKey);
  assert.deepEqual(costOwnerUserIdClaim(identity), {
    cost_owner_user_id: seeded.userId,
  });
  assert.deepEqual(billingSubjectClaim(identity), {
    billing_subject_key: buildOwnerCustomerKey(seeded.userId),
    cost_owner_user_id: seeded.userId,
  });
  assert.equal(
    signerBalanceGateSubject(identity, endUserId),
    `owner:${seeded.userId}`,
  );
});

test("live merchant end-user bills stable eu_ customer", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const endUserId = `ext-${randomUUID()}`;

  await upsertAppBillingConfig(seeded.clientId, {
    billingMode: "merchant",
    stripeLivemode: true,
  });
  resetBillingIdentityCache();
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: seeded.clientId,
    externalUserId: endUserId,
  });
  assert.equal(identity.isOwner, false);
  assert.equal(identity.sharesOwnerCostRail, false);
  assert.equal(identity.payerKind, "end_user");
  assert.equal(identity.payerPlatformUserId, undefined);
  assert.ok(isEndUserCustomerKey(identity.payerCustomerKey));
  assert.equal(identity.customerKey, identity.payerCustomerKey);
  assert.equal(identity.actorEndUserId, identity.payerCustomerKey);
  assert.equal(identity.actorExternalUserId, endUserId);
  assert.equal(appUserRetailCustomerKey(identity), identity.customerKey);
  assert.equal(
    identity.legacyCompoundCustomerKey,
    buildOpenMeterCustomerKey(seeded.clientId, endUserId),
  );
  assert.deepEqual(costOwnerUserIdClaim(identity), {});
  assert.deepEqual(billingSubjectClaim(identity), {
    billing_subject_key: identity.payerCustomerKey,
  });
  assert.equal(
    signerBalanceGateSubject(identity, endUserId),
    identity.payerCustomerKey,
  );
  assert.equal(
    identity.payerCustomerKey,
    buildEndUserCustomerKey(identity.actorEndUserId.replace(/^eu_/, "")),
  );
});

test("sandbox merchant end-user bills sbx_eu_ customer", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const endUserId = `ext-${randomUUID()}`;

  await upsertAppBillingConfig(seeded.clientId, {
    billingMode: "merchant",
    stripeLivemode: false,
  });
  resetBillingIdentityCache();
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: seeded.clientId,
    externalUserId: endUserId,
  });
  assert.equal(identity.isOwner, false);
  assert.equal(identity.sharesOwnerCostRail, false);
  assert.equal(identity.payerKind, "end_user");
  assert.ok(isSandboxEndUserCustomerKey(identity.payerCustomerKey));
  assert.ok(isEndUserCustomerKey(identity.payerCustomerKey));
  assert.equal(identity.customerKey, identity.payerCustomerKey);
  assert.notEqual(identity.actorEndUserId, identity.payerCustomerKey);
  assert.equal(appUserRetailCustomerKey(identity), identity.customerKey);
  assert.equal(
    identity.payerCustomerKey,
    buildSandboxEndUserCustomerKey(identity.actorEndUserId),
  );
  assert.deepEqual(billingSubjectClaim(identity), {
    billing_subject_key: identity.payerCustomerKey,
  });
});

test("normal app owner bills shared owner wallet", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));

  resetBillingIdentityCache();
  const identity = await resolveOpenMeterBillingIdentity({
    clientId: seeded.clientId,
    externalUserId: seeded.userId,
  });
  assert.equal(identity.isOwner, true);
  assert.equal(identity.sharesOwnerCostRail, true);
  assert.equal(identity.payerKind, "platform_user");
  assert.equal(identity.payerPlatformUserId, seeded.userId);
  assert.equal(identity.customerKey, buildOwnerCustomerKey(seeded.userId));
  assert.equal(appUserRetailCustomerKey(identity), identity.customerKey);
  assert.deepEqual(costOwnerUserIdClaim(identity), {});
  assert.deepEqual(billingSubjectClaim(identity), {});
});

test("assertAppUserRetailBillingSubject rejects owner wallet targets", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const endUserId = `ext-${randomUUID()}`;

  resetBillingIdentityCache();
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
  resetBillingIdentityCache();
  await assert.doesNotReject(() =>
    assertAppUserRetailBillingSubject({
      clientId: seeded.clientId,
      externalUserId: endUserId,
    }),
  );
});

test("assertAppUserRetailBillingSubject rejects platform-default members", async (t) => {
  const seeded = await seedDeveloperAppWithClient();
  t.after(async () => cleanupTestApp(seeded));
  const memberId = await createTestUserWithCleanup(t);

  resetBillingIdentityCache();
  await withTemporaryPlatformDefault(seeded.clientId, async () => {
    resetBillingIdentityCache();
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
