import test from "node:test";
import assert from "node:assert/strict";

import type { OpenMeter } from "@openmeter/sdk";

import {
  buildAppCapabilityFeatureKey,
  buildCapabilityFeatureKey,
  buildCapabilityMeterGroupByFilters,
  capabilityWireAppAttribution,
  ensureCapabilityOpenMeterFeature,
  resolveCapabilityFeatureKey,
  validateCapabilityFeatureKeys,
} from "./capability-features";
import { billingStableFeatureKeysEnabled } from "@/lib/billing/feature-flags";
import { OPENMETER_SLUG_KEY_PATTERN } from "./slug-keys";

test("buildCapabilityFeatureKey matches OpenMeter slug pattern", () => {
  const key = buildCapabilityFeatureKey({
    clientId: "app_51803fb3e53dce667cf0e4df",
    planId: "8c940aad-455e-4bf0-b3a5-6fc3759451d6",
    pipeline: "live-video-to-video",
    modelId: "stabilityai/sdxl",
  });
  assert.match(key, OPENMETER_SLUG_KEY_PATTERN);
});

test("buildAppCapabilityFeatureKey matches OpenMeter slug pattern", () => {
  const key = buildAppCapabilityFeatureKey({
    clientId: "app_51803fb3e53dce667cf0e4df",
    pipeline: "live-video-to-video",
    modelId: "*",
  });
  assert.match(key, OPENMETER_SLUG_KEY_PATTERN);
});

test("resolveCapabilityFeatureKey uses app-scoped key when stable keys enabled", (t) => {
  if (!billingStableFeatureKeysEnabled()) {
    t.skip("billing stable feature keys disabled");
    return;
  }
  assert.equal(
    resolveCapabilityFeatureKey({
      clientId: "app_1",
      planId: "plan-1",
      pipeline: "text-to-image",
      modelId: "*",
    }),
    buildAppCapabilityFeatureKey({
      clientId: "app_1",
      pipeline: "text-to-image",
      modelId: "*",
    }),
  );
});

test("validateCapabilityFeatureKeys accepts typical capability rows", () => {
  const result = validateCapabilityFeatureKeys({
    clientId: "app_51803fb3e53dce667cf0e4df",
    planId: "8c940aad-455e-4bf0-b3a5-6fc3759451d6",
    capabilities: [{ pipeline: "live-video-to-video", modelId: "*" }],
  });
  assert.equal(result.ok, true);
});

test("capabilityWireAppAttribution matches ingest data.app", () => {
  assert.equal(
    capabilityWireAppAttribution({
      pipeline: "livepeer-example",
      modelId: "hello-world",
    }),
    "livepeer-example/hello-world",
  );
  assert.equal(
    capabilityWireAppAttribution({
      pipeline: "live-video-to-video",
      modelId: "scope",
    }),
    "live-video-to-video/scope",
  );
  assert.equal(
    capabilityWireAppAttribution({
      pipeline: "streamdiffusion-sdxl",
      modelId: "streamdiffusion-sdxl",
    }),
    "streamdiffusion-sdxl",
  );
  assert.equal(
    capabilityWireAppAttribution({
      pipeline: "text-to-image",
      modelId: "stabilityai/sdxl",
    }),
    "text-to-image/stabilityai/sdxl",
  );
  assert.equal(
    capabilityWireAppAttribution({ pipeline: "  ", modelId: "hello" }),
    "hello",
  );
  assert.equal(
    capabilityWireAppAttribution({ pipeline: "pipe", modelId: "  " }),
    "",
  );
  assert.equal(
    capabilityWireAppAttribution({ pipeline: "pipe", modelId: "*" }),
    "*",
  );
  assert.equal(
    capabilityWireAppAttribution({ pipeline: " pipe ", modelId: " model " }),
    "pipe/model",
  );
});

type FeatureRow = {
  id?: string;
  key: string;
  advancedMeterGroupByFilters?: Record<string, unknown> | null;
};

function featureClient(handlers: {
  list?: () => Promise<unknown>;
  get?: (id: string) => Promise<FeatureRow>;
  delete?: (id: string) => Promise<void>;
  create?: (input: { key: string; advancedMeterGroupByFilters: unknown }) => Promise<unknown>;
}): OpenMeter {
  return {
    features: {
      list: handlers.list ?? (async () => []),
      get: handlers.get ?? (async () => ({ key: "" })),
      delete: handlers.delete ?? (async () => undefined),
      create: handlers.create ?? (async () => ({})),
    },
  } as unknown as OpenMeter;
}

const ensureInput = {
  clientId: "app_1",
  planId: "plan-1",
  pipeline: "livepeer-example",
  modelId: "hello-world",
  displayName: "Hello",
};

test("ensureCapabilityOpenMeterFeature creates a feature when none exists", async () => {
  const created: unknown[] = [];
  const key = await ensureCapabilityOpenMeterFeature({
    ...ensureInput,
    client: featureClient({
      list: async () => {
        throw new Error("list down");
      },
      create: async (input) => {
        created.push(input);
        return {};
      },
    }),
  });
  assert.equal(created.length, 1);
  assert.equal(
    (created[0] as { advancedMeterGroupByFilters: { app: { $eq: string } } })
      .advancedMeterGroupByFilters.app.$eq,
    "livepeer-example/hello-world",
  );
  assert.equal(key, (created[0] as { key: string }).key);
});

test("ensureCapabilityOpenMeterFeature keeps a feature whose filters already match", async () => {
  const key = buildAppCapabilityFeatureKey({
    clientId: "app_1",
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  const filters = buildCapabilityMeterGroupByFilters({
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  let created = 0;
  let deleted = 0;
  const result = await ensureCapabilityOpenMeterFeature({
    ...ensureInput,
    preferredKey: key,
    client: featureClient({
      list: async () => ({
        items: [{ id: "feat_1", key, advancedMeterGroupByFilters: { pipeline: "stale" } }],
      }),
      get: async () => ({
        id: "feat_1",
        key,
        advancedMeterGroupByFilters: filters,
      }),
      create: async () => {
        created += 1;
        return {};
      },
      delete: async () => {
        deleted += 1;
      },
    }),
  });
  assert.equal(result, key);
  assert.equal(created, 0);
  assert.equal(deleted, 0);
});

test("ensureCapabilityOpenMeterFeature forks a shared feature instead of deleting it", async () => {
  const sharedKey = buildAppCapabilityFeatureKey({
    clientId: "app_1",
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  const planKey = buildCapabilityFeatureKey({
    clientId: "app_1",
    planId: "plan-1",
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  const deleted: string[] = [];
  const created: string[] = [];
  const result = await ensureCapabilityOpenMeterFeature({
    ...ensureInput,
    client: featureClient({
      list: async () => [
        {
          id: "feat_shared",
          key: sharedKey,
          advancedMeterGroupByFilters: {
            pipeline: { $eq: "livepeer-example" },
            app: { $eq: "hello-world" },
          },
        },
      ],
      get: async () => {
        throw new Error("get down");
      },
      delete: async (id) => {
        deleted.push(id);
      },
      create: async (input) => {
        created.push(input.key);
        return {};
      },
    }),
  });
  assert.equal(result, planKey);
  assert.deepEqual(deleted, []);
  assert.deepEqual(created, [planKey]);
});

test("ensureCapabilityOpenMeterFeature reuses an existing plan-scoped feature", async () => {
  const sharedKey = buildAppCapabilityFeatureKey({
    clientId: "app_1",
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  const planKey = buildCapabilityFeatureKey({
    clientId: "app_1",
    planId: "plan-1",
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  const filters = buildCapabilityMeterGroupByFilters({
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  const deleted: string[] = [];
  let created = 0;
  const result = await ensureCapabilityOpenMeterFeature({
    ...ensureInput,
    preferredKey: sharedKey,
    client: featureClient({
      list: async () => [
        {
          id: "feat_shared",
          key: sharedKey,
          advancedMeterGroupByFilters: {
            pipeline: { $eq: "livepeer-example" },
            app: { $eq: "hello-world" },
          },
        },
        { id: "feat_plan", key: planKey, advancedMeterGroupByFilters: filters },
      ],
      delete: async (id) => {
        deleted.push(id);
      },
      create: async () => {
        created += 1;
        return {};
      },
    }),
  });
  assert.equal(result, planKey);
  assert.deepEqual(deleted, []);
  assert.equal(created, 0);
});

test("ensureCapabilityOpenMeterFeature replaces a plan-scoped feature with stale filters", async () => {
  const key = buildCapabilityFeatureKey({
    clientId: "app_1",
    planId: "plan-1",
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  const deleted: string[] = [];
  const created: string[] = [];
  const result = await ensureCapabilityOpenMeterFeature({
    ...ensureInput,
    preferredKey: key,
    client: featureClient({
      list: async () => [
        {
          id: "feat_old",
          key,
          advancedMeterGroupByFilters: {
            pipeline: { $eq: "livepeer-example" },
            app: { $eq: "hello-world" },
          },
        },
      ],
      get: async () => {
        throw new Error("get down");
      },
      delete: async (id) => {
        deleted.push(id);
      },
      create: async (input) => {
        created.push(input.key);
        return {};
      },
    }),
  });
  assert.equal(result, key);
  assert.deepEqual(deleted, ["feat_old"]);
  assert.deepEqual(created, [key]);
});

test("ensureCapabilityOpenMeterFeature leaves features without filter payloads", async () => {
  const key = buildAppCapabilityFeatureKey({
    clientId: "app_1",
    pipeline: "text-to-image",
    modelId: "*",
  });
  let created = 0;
  const result = await ensureCapabilityOpenMeterFeature({
    ...ensureInput,
    pipeline: "text-to-image",
    modelId: "*",
    client: featureClient({
      list: async () => [{ key, advancedMeterGroupByFilters: null }],
      get: async () => ({ key: "" }),
      create: async () => {
        created += 1;
        return {};
      },
    }),
  });
  assert.equal(result, key);
  assert.equal(created, 0);
});

test("ensureCapabilityOpenMeterFeature throws when stale filters have no id", async () => {
  const key = buildCapabilityFeatureKey({
    clientId: "app_1",
    planId: "plan-1",
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  const staleShapes: Array<Record<string, unknown>> = [
    {
      pipeline: { $eq: "livepeer-example" },
      app: { $eq: { nested: true } },
    },
    {
      pipeline: "bare",
      app: { $eq: false },
    },
    {
      pipeline: null,
      app: { $eq: "livepeer-example/hello-world" },
    },
    {
      pipeline: { nope: true },
      app: { $eq: "livepeer-example/hello-world" },
    },
    {
      pipeline: { $eq: "livepeer-example" },
      app: { $eq: "livepeer-example/hello-world" },
      extra: { $eq: "unused" },
    },
  ];
  for (const advancedMeterGroupByFilters of staleShapes) {
    await assert.rejects(
      () =>
        ensureCapabilityOpenMeterFeature({
          ...ensureInput,
          preferredKey: key,
          client: featureClient({
            list: async () => [{ key, advancedMeterGroupByFilters }],
          }),
        }),
      /cannot be replaced/,
    );
  }
});

test("ensureCapabilityOpenMeterFeature uses the list row when get omits a key", async () => {
  const key = buildAppCapabilityFeatureKey({
    clientId: "app_1",
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  const filters = buildCapabilityMeterGroupByFilters({
    pipeline: "livepeer-example",
    modelId: "hello-world",
  });
  let created = 0;
  const result = await ensureCapabilityOpenMeterFeature({
    ...ensureInput,
    preferredKey: "not a slug",
    client: featureClient({
      list: async () => [
        { id: "other", key: "someone_else" },
        { id: "feat_1", key, advancedMeterGroupByFilters: filters },
      ],
      get: async () => ({ id: "feat_1", key: "" }),
      create: async () => {
        created += 1;
        return {};
      },
    }),
  });
  assert.equal(result, key);
  assert.equal(created, 0);
});

test("buildCapabilityMeterGroupByFilters uses wire app, omits for wildcard", () => {
  assert.deepEqual(
    buildCapabilityMeterGroupByFilters({ pipeline: "text-to-image", modelId: "*" }),
    { pipeline: { $eq: "text-to-image" } },
  );
  assert.deepEqual(
    buildCapabilityMeterGroupByFilters({
      pipeline: "livepeer-example",
      modelId: "hello-world",
    }),
    {
      pipeline: { $eq: "livepeer-example" },
      app: { $eq: "livepeer-example/hello-world" },
    },
  );
  assert.deepEqual(
    buildCapabilityMeterGroupByFilters({
      pipeline: "streamdiffusion-sdxl",
      modelId: "streamdiffusion-sdxl",
    }),
    {
      pipeline: { $eq: "streamdiffusion-sdxl" },
      app: { $eq: "streamdiffusion-sdxl" },
    },
  );
});
