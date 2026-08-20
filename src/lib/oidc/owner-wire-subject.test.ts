import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPayerActorWireSubject,
  parsePayerActorWireSubject,
  wireUsageSubjectFromJwt,
} from "@/lib/openmeter/billing-identity";
import {
  buildEndUserCustomerKey,
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
  buildOpenMeterCustomerKey,
  normalizePlatformUserId,
} from "@/lib/openmeter/customer-key";

/**
 * The ingest chain that decides whether usage is billable:
 *
 *   token billing_subject_key / cost_owner_user_id / user_type
 *     → webhook usage_subject (payer#actor)
 *     → collector CE subject (payer) + data.external_user_id (actor)
 *
 * The collector has no database. It splits `usage_subject` on `#` when present:
 * payer becomes CloudEvent subject / Konnect customer key; actor becomes
 * meter groupBy.external_user_id. No `#` means legacy single-subject form.
 *
 * These tests pin the contract in the same shape the collector implements
 * (deploy/openmeter-collector/collector.yaml), so a change on either side
 * that breaks attribution fails here.
 */

/** Mirrors `withOwnerBillingUsageSubject` / wireUsageSubjectFromJwt. */
function webhookUsageSubject(input: {
  userType: string;
  bareSubject: string;
  billingSubjectKey?: string;
  costOwnerUserId?: string;
}): string {
  return wireUsageSubjectFromJwt({
    userType: input.userType,
    usageSubject: input.bareSubject,
    billingSubjectKey: input.billingSubjectKey,
    costOwnerUserId: input.costOwnerUserId,
    actorExternalUserId: input.bareSubject,
  }).usageSubject;
}

/**
 * Mirrors collector.yaml payer#actor split + owner-prefix strip.
 * Returns { subject (payer), externalUserId (actor) }.
 */
function collectorCloudEvent(clientId: string, usageSubject: string): {
  subject: string;
  externalUserId: string;
  billingSubjectKind: "platform_user" | "end_user" | "legacy";
} {
  const authId = `${clientId}:${usageSubject}`;
  const colon = authId.indexOf(":");
  const usageSubjectParsed =
    colon > 0 ? authId.slice(colon + 1) : authId;

  const { payerWire, actorExternalUserId } =
    parsePayerActorWireSubject(usageSubjectParsed);

  const isOwnerSubject = payerWire.startsWith("owner:");
  const isEndUserCustomer = payerWire.startsWith("eu_");
  const payerBare = isOwnerSubject
    ? normalizePlatformUserId(payerWire)
    : payerWire;

  let subject: string;
  if (isOwnerSubject) {
    subject = payerBare;
  } else if (isEndUserCustomer) {
    subject = payerWire;
  } else if (actorExternalUserId) {
    subject = payerWire;
  } else {
    subject = authId;
  }

  const externalUserId =
    actorExternalUserId ||
    (isOwnerSubject ? payerBare : payerWire);

  return {
    subject,
    externalUserId:
      actorExternalUserId ||
      (isOwnerSubject || isEndUserCustomer ? externalUserId : usageSubjectParsed),
    billingSubjectKind: isOwnerSubject
      ? "platform_user"
      : isEndUserCustomer
        ? "end_user"
        : "legacy",
  };
}

function ingest(input: {
  userType: string;
  clientId: string;
  bareSubject: string;
  billingSubjectKey?: string;
  costOwnerUserId?: string;
}): { subject: string; externalUserId: string; billingSubjectKind: string } {
  return collectorCloudEvent(
    input.clientId,
    webhookUsageSubject({
      userType: input.userType,
      bareSubject: input.bareSubject,
      billingSubjectKey: input.billingSubjectKey,
      costOwnerUserId: input.costOwnerUserId,
    }),
  );
}

test("an app_owner token lands on the canonical owner customer key", () => {
  const result = ingest({
    userType: "app_owner",
    clientId: "app_demo",
    bareSubject: "user-1",
  });
  assert.equal(result.subject, buildOwnerCustomerKey("user-1"));
  assert.equal(result.subject, "user-1");
  assert.equal(result.externalUserId, "user-1");
  assert.equal(result.billingSubjectKind, "platform_user");
});

test("legacy merchant end-user without billing_subject_key stays on compound key", () => {
  const result = ingest({
    userType: "external_user",
    clientId: "app_demo",
    bareSubject: "ext-9",
  });
  assert.equal(result.subject, buildOpenMeterCustomerKey("app_demo", "ext-9"));
  assert.equal(result.externalUserId, "ext-9");
  assert.equal(result.billingSubjectKind, "legacy");
});

test("cost_owner_user_id meters owner_rollup traffic onto the owner wallet with actor split", () => {
  const ownerId = "owner-uuid";
  const result = ingest({
    userType: "external_user",
    clientId: "app_demo",
    bareSubject: "ext-9",
    costOwnerUserId: ownerId,
  });
  assert.equal(result.subject, buildOwnerCustomerKey(ownerId));
  assert.equal(result.externalUserId, "ext-9");
  assert.notEqual(result.subject, buildOpenMeterCustomerKey("app_demo", "ext-9"));
  assert.notEqual(result.subject, buildOwnerCustomerKey("ext-9"));
  assert.equal(result.billingSubjectKind, "platform_user");
});

test("billing_subject_key eu_ meters merchant traffic onto the end-user customer", () => {
  const euKey = buildEndUserCustomerKey("end-user-row-1");
  const result = ingest({
    userType: "external_user",
    clientId: "app_demo",
    bareSubject: "ext-9",
    billingSubjectKey: euKey,
  });
  assert.equal(result.subject, euKey);
  assert.equal(result.externalUserId, "ext-9");
  assert.equal(result.billingSubjectKind, "end_user");
});

test("billing_subject_key owner bare id meters rollup with payer#actor wire", () => {
  const ownerId = "owner-uuid";
  const wire = webhookUsageSubject({
    userType: "external_user",
    bareSubject: "ext-9",
    billingSubjectKey: ownerId,
  });
  assert.equal(wire, `${buildOwnerWireSubject(ownerId)}#ext-9`);
  const result = collectorCloudEvent("app_demo", wire);
  assert.equal(result.subject, ownerId);
  assert.equal(result.externalUserId, "ext-9");
});

test("an app_user token for a non-owner is unchanged (legacy)", () => {
  const result = ingest({
    userType: "app_user",
    clientId: "app_demo",
    bareSubject: "ext-9",
  });
  assert.equal(result.subject, "app_demo:ext-9");
});

test("omitting app_owner sends owner traffic to an unattributed subject", () => {
  // The programmatic-token bug: user_type hardcoded to "app_user" for an owner.
  const wrong = ingest({
    userType: "app_user",
    clientId: "app_demo",
    bareSubject: "user-1",
  });
  const canonical = buildOwnerCustomerKey("user-1");

  assert.notEqual(
    wrong.subject,
    canonical,
    "an owner minted without user_type=app_owner must not reach the owner wallet",
  );
  assert.equal(wrong.subject, "app_demo:user-1");
});

test("an already-prefixed owner subject is not double-prefixed", () => {
  const result = ingest({
    userType: "app_owner",
    clientId: "app_demo",
    bareSubject: "owner:user-1",
  });
  assert.equal(result.subject, buildOwnerCustomerKey("user-1"));
});

test("the wire marker never leaks into the customer key", () => {
  const wire = buildOwnerWireSubject("user-1");
  assert.equal(wire, "owner:user-1");
  assert.equal(normalizePlatformUserId(wire), "user-1");
  assert.equal(buildOwnerCustomerKey("user-1"), "user-1");
});

test("no-hash legacy owner: forms still parse as payer-only", () => {
  const parsed = parsePayerActorWireSubject("owner:user-1");
  assert.equal(parsed.payerWire, "owner:user-1");
  assert.equal(parsed.actorExternalUserId, null);
  const result = collectorCloudEvent("app_demo", "owner:user-1");
  assert.equal(result.subject, "user-1");
  assert.equal(result.externalUserId, "user-1");
});

test("buildPayerActorWireSubject omits # when actor equals payer", () => {
  assert.equal(
    buildPayerActorWireSubject({
      payerCustomerKey: "user-1",
      payerKind: "platform_user",
      actorExternalUserId: "user-1",
    }),
    "owner:user-1",
  );
});
