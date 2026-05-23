import assert from "node:assert/strict";
import test from "node:test";

import type { AuthResult } from "@/lib/auth";
import {
  buildCachedManifestPolicy,
  enforceCachedManifestPolicy,
  isPipelineAllowedByPolicy,
  publishCachedManifestPolicy,
  resetManifestPolicyCacheForTests,
  resolveSigningPipelineConstraint,
  seedCachedManifestPolicyForTests,
} from "@/lib/app-manifest-cache";

const AUTH: AuthResult = {
  userId: "user-1",
  endUserId: null,
  appId: "app_test123",
  sessionId: "sess-1",
  scopes: "sign:job",
  tokenHash: "hash",
};

test.after(() => {
  resetManifestPolicyCacheForTests();
});

test("isPipelineAllowedByPolicy allows pipeline-only when any model exists", () => {
  const policy = buildCachedManifestPolicy("app_test123", {
    capabilities: [
      { pipeline: "text-to-image", modelId: "model-a" },
      { pipeline: "text-to-image", modelId: "model-b" },
    ],
    excludedCapabilities: [],
    manifestVersion: "v1",
  });
  assert.equal(isPipelineAllowedByPolicy(policy, "text-to-image"), true);
  assert.equal(isPipelineAllowedByPolicy(policy, "text-to-image", "model-a"), true);
  assert.equal(isPipelineAllowedByPolicy(policy, "text-to-image", "model-c"), false);
  assert.equal(isPipelineAllowedByPolicy(policy, "llm"), false);
});

test("resolveSigningPipelineConstraint accepts pipeline without modelId", async () => {
  const c = await resolveSigningPipelineConstraint({
    pipeline: "text-to-image",
  });
  assert.deepEqual(c, { pipeline: "text-to-image" });
});

test("enforceCachedManifestPolicy rejects cache miss", async () => {
  resetManifestPolicyCacheForTests();
  const result = await enforceCachedManifestPolicy(
    { pipeline: "text-to-image", modelId: "model-a" },
    AUTH,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "manifest_cache_unavailable");
});

test("enforceCachedManifestPolicy rejects missing pipeline", async () => {
  seedCachedManifestPolicyForTests("app_test123", {
    capabilities: [{ pipeline: "text-to-image", modelId: "model-a" }],
    excludedCapabilities: [],
    manifestVersion: "v1",
  });
  const result = await enforceCachedManifestPolicy({ InPixels: 100 }, AUTH);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.body.error, "capability_not_allowed");
});

test("enforceCachedManifestPolicy allows cached pipeline and model", async () => {
  publishCachedManifestPolicy("app_test123", {
    capabilities: [{ pipeline: "text-to-image", modelId: "stabilityai/sdxl" }],
    excludedCapabilities: [],
    manifestVersion: "v2",
  });
  const result = await enforceCachedManifestPolicy(
    {
      pipeline: "text-to-image",
      modelId: "stabilityai/sdxl",
    },
    AUTH,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.constraint, {
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
  });
});

test("enforceCachedManifestPolicy allows pipeline-only when model omitted", async () => {
  publishCachedManifestPolicy("app_test123", {
    capabilities: [
      { pipeline: "text-to-image", modelId: "stabilityai/sdxl" },
      { pipeline: "text-to-image", modelId: "other" },
    ],
    excludedCapabilities: [],
    manifestVersion: "v3",
  });
  const result = await enforceCachedManifestPolicy(
    { pipeline: "text-to-image" },
    AUTH,
  );
  assert.equal(result.ok, true);
});
