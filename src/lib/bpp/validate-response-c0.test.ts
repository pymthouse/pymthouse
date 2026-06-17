import test from "node:test";
import assert from "node:assert/strict";

import {
  buildC0ValidateResponseBody,
  toCapabilityIds,
  CAPABILITY_WILDCARD,
} from "./validate-response-c0";
import { fromSubscriptionRef } from "./subscription-ref";
import { findLeakedInternalFieldNames } from "./forbidden-fields";

const OPENMETER_ULID = "01J8ZQ9X7K6M3N2P4R5S6T7U8V";

/**
 * Structural validator mirroring
 * `contracts/billing-provider-protocol/validate.schema.json` (C0 ② response).
 * Kept in-repo (like `forbidden-fields`) so pymthouse can assert conformance at
 * the producing edge without depending on the cross-repo contract file or an
 * external JSON-schema dependency.
 */
const C0_TOP_LEVEL_KEYS = new Set([
  "valid",
  "user",
  "billing_account",
  "capabilities",
  "quota",
  "subscriptionRef",
  "signerSession",
]);
const C0_BILLING_ACCOUNT_KEYS = new Set(["id", "providerSlug", "billingMode"]);
const C0_BILLING_MODES = new Set(["delegated", "prepay"]);
const CAPABILITY_RE = /^(\*|[^:]+:[^:]+|tool:[^:]+)$/;

function assertConformsToC0(body: Record<string, unknown>): void {
  // required + additionalProperties:false
  assert.equal(typeof body.valid, "boolean", "valid must be boolean");
  for (const key of Object.keys(body)) {
    assert.ok(C0_TOP_LEVEL_KEYS.has(key), `unexpected top-level key: ${key}`);
  }

  if ("user" in body) {
    const user = body.user as Record<string, unknown>;
    assert.deepEqual(Object.keys(user), ["sub"], "user must contain only `sub`");
    assert.equal(typeof user.sub, "string");
    assert.ok((user.sub as string).length >= 1, "user.sub must be non-empty");
  }

  if ("billing_account" in body) {
    const acct = body.billing_account as Record<string, unknown>;
    for (const key of Object.keys(acct)) {
      assert.ok(C0_BILLING_ACCOUNT_KEYS.has(key), `unexpected billing_account key: ${key}`);
    }
    assert.equal(typeof acct.id, "string");
    assert.ok((acct.id as string).length >= 1);
    assert.equal(typeof acct.providerSlug, "string");
    assert.ok((acct.providerSlug as string).length >= 1);
    assert.ok(C0_BILLING_MODES.has(acct.billingMode as string), "billingMode enum");
  }

  if ("capabilities" in body) {
    const caps = body.capabilities;
    assert.ok(Array.isArray(caps), "capabilities must be an array");
    for (const cap of caps as unknown[]) {
      assert.equal(typeof cap, "string");
      assert.ok((cap as string).length >= 1);
      assert.match(cap as string, CAPABILITY_RE, `capability shape: ${String(cap)}`);
    }
  }

  if ("quota" in body) {
    const quota = body.quota;
    if (quota !== null) {
      const q = quota as Record<string, unknown>;
      for (const key of Object.keys(q)) {
        assert.ok(["remaining", "resetAt"].includes(key), `unexpected quota key: ${key}`);
      }
      assert.equal(typeof q.remaining, "number");
    }
  }

  if ("subscriptionRef" in body) {
    assert.equal(typeof body.subscriptionRef, "string");
    assert.ok((body.subscriptionRef as string).length >= 1);
  }

  if ("signerSession" in body) {
    const s = body.signerSession as Record<string, unknown>;
    assert.deepEqual(Object.keys(s).sort(), ["headers", "url"]);
    assert.equal(typeof s.url, "string");
    assert.equal(typeof s.headers, "object");
  }

  // Seam isolation: no provider-internal field NAME anywhere in the response.
  assert.deepEqual(findLeakedInternalFieldNames(body), []);
}

test("C0 validate body conforms to validate.schema.json (delegated MVP — wildcard, no quota)", () => {
  const body = buildC0ValidateResponseBody({
    sub: "user_abc",
    billingAccount: { id: "app_123", providerSlug: "pymthouse", billingMode: "delegated" },
    capabilities: [CAPABILITY_WILDCARD],
    quota: null,
  });
  assertConformsToC0(body);
  assert.equal(body.valid, true);
  assert.deepEqual(body.user, { sub: "user_abc" });
  assert.deepEqual(body.capabilities, ["*"]);
  assert.equal(body.quota, null);
});

test("C0 validate body conforms with pipeline:model capabilities + subscriptionRef", () => {
  const body = buildC0ValidateResponseBody({
    sub: "user_abc",
    billingAccount: { id: "app_123", providerSlug: "pymthouse", billingMode: "prepay" },
    capabilities: ["text-to-image:sdxl", "text-to-video:ltx"],
    quota: { remaining: 12345, resetAt: "2026-07-01T00:00:00.000Z" },
    openmeterSubscriptionId: OPENMETER_ULID,
  });
  assertConformsToC0(body);
  // subscriptionRef is opaque + provider-decodable, never the raw OM id.
  const ref = body.subscriptionRef as string;
  assert.match(ref, /^subref_/);
  assert.ok(!ref.includes(OPENMETER_ULID));
  assert.equal(fromSubscriptionRef(ref), OPENMETER_ULID);
});

test("C0 validate body NEVER leaks the forbidden public client_id / allowedModels / plan keys", () => {
  const body = buildC0ValidateResponseBody({
    sub: "user_abc",
    billingAccount: { id: "app_123", providerSlug: "pymthouse", billingMode: "delegated" },
    capabilities: ["text-to-image:sdxl"],
    openmeterSubscriptionId: OPENMETER_ULID,
  });
  assert.ok(!("client_id" in body), "client_id must be removed (⑨ forbidden)");
  assert.ok(!("allowedModels" in body), "allowedModels must be reshaped to capabilities");
  assert.ok(!("plan" in body), "plan is not part of the C0 ② contract");
  assert.ok(!("openmeter_subscription_id" in body));
});

test("C0 validate body includes an optional signerSession when provided", () => {
  const body = buildC0ValidateResponseBody({
    sub: "user_abc",
    billingAccount: { id: "app_123", providerSlug: "pymthouse", billingMode: "delegated" },
    capabilities: ["*"],
    signerSession: {
      url: "https://signer.example/session",
      headers: { Authorization: "Bearer provider-token" },
    },
  });
  assertConformsToC0(body);
  assert.deepEqual(body.signerSession, {
    url: "https://signer.example/session",
    headers: { Authorization: "Bearer provider-token" },
  });
});

test("toCapabilityIds maps pipeline+model rows to sorted, de-duplicated pipeline:model ids", () => {
  const ids = toCapabilityIds([
    { pipeline: "text-to-video", modelId: "ltx" },
    { pipeline: "text-to-image", modelId: "sdxl" },
    { pipeline: "text-to-image", modelId: "sdxl" }, // dup
    { pipeline: "text-to-image", modelId: null }, // skipped
    { pipeline: null, modelId: "sdxl" }, // skipped
  ]);
  assert.deepEqual(ids, ["text-to-image:sdxl", "text-to-video:ltx"]);
});
