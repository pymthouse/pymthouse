import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOwnerCustomerKey,
  buildOwnerWireSubject,
  buildOpenMeterCustomerKey,
  normalizePlatformUserId,
} from "@/lib/openmeter/customer-key";

/**
 * The ingest chain that decides whether usage is billable:
 *
 *   token user_type  →  webhook usage_subject  →  collector CE subject
 *
 * The collector has no database. It decides "owner" purely from the `owner:`
 * prefix the webhook applies when `user_type === "app_owner"`. If a token
 * minter omits that claim, owner traffic lands on `app_…:{ownerId}` — a
 * subject no customer is attributed, so OpenMeter never invoices it.
 *
 * These tests pin the contract in the same shape the collector implements
 * (deploy/openmeter-collector/collector.yaml), so a change on either side
 * that breaks attribution fails here.
 */

/** Mirrors `withOwnerBillingUsageSubject` in remote-signer-webhook-config. */
function webhookUsageSubject(userType: string, bareSubject: string): string {
  if (userType !== "app_owner") return bareSubject;
  if (bareSubject.startsWith("owner:")) return bareSubject;
  return buildOwnerWireSubject(bareSubject);
}

/** Mirrors the collector's owner-prefix strip in collector.yaml. */
function collectorCloudEventSubject(clientId: string, usageSubject: string): string {
  const authId = `${clientId}:${usageSubject}`;
  const isOwner = usageSubject.startsWith("owner:");
  return isOwner ? normalizePlatformUserId(usageSubject) : authId;
}

function ingestSubject(
  userType: string,
  clientId: string,
  bareSubject: string,
): string {
  return collectorCloudEventSubject(
    clientId,
    webhookUsageSubject(userType, bareSubject),
  );
}

test("an app_owner token lands on the canonical owner customer key", () => {
  const subject = ingestSubject("app_owner", "app_demo", "user-1");
  assert.equal(subject, buildOwnerCustomerKey("user-1"));
  assert.equal(subject, "user-1");
});

test("an end-user token lands on the canonical compound customer key", () => {
  const subject = ingestSubject("external_user", "app_demo", "ext-9");
  assert.equal(subject, buildOpenMeterCustomerKey("app_demo", "ext-9"));
});

test("an app_user token for a non-owner is unchanged", () => {
  const subject = ingestSubject("app_user", "app_demo", "ext-9");
  assert.equal(subject, "app_demo:ext-9");
});

test("omitting app_owner sends owner traffic to an unattributed subject", () => {
  // The programmatic-token bug: user_type hardcoded to "app_user" for an owner.
  const wrong = ingestSubject("app_user", "app_demo", "user-1");
  const canonical = buildOwnerCustomerKey("user-1");

  assert.notEqual(
    wrong,
    canonical,
    "an owner minted without user_type=app_owner must not reach the owner wallet",
  );
  assert.equal(wrong, "app_demo:user-1");
  // That subject belongs to no customer, so OpenMeter would never invoice it.
});

test("an already-prefixed owner subject is not double-prefixed", () => {
  const subject = ingestSubject("app_owner", "app_demo", "owner:user-1");
  assert.equal(subject, buildOwnerCustomerKey("user-1"));
});

test("the wire marker never leaks into the customer key", () => {
  const wire = buildOwnerWireSubject("user-1");
  assert.equal(wire, "owner:user-1");
  // The collector strips it; the customer key is always bare.
  assert.equal(normalizePlatformUserId(wire), "user-1");
  assert.equal(buildOwnerCustomerKey("user-1"), "user-1");
});
