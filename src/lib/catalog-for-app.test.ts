import assert from "node:assert/strict";
import { test } from "node:test";

import { catalogForServiceTypes } from "./catalog-for-app";
import type { PipelineCatalogEntry } from "./naap-catalog";

const sampleCatalog: PipelineCatalogEntry[] = [
  {
    id: "openai:audio-speech",
    name: "openai:audio-speech",
    models: ["default"],
    serviceType: "legacy",
  },
  {
    id: "openai:audio-speech",
    name: "openai:audio-speech",
    models: ["kokoro"],
    serviceType: "registry",
  },
  {
    id: "streamdiffusion-sdxl",
    name: "streamdiffusion-sdxl",
    models: ["default"],
    serviceType: "legacy",
  },
  {
    id: "openai:chat-completions",
    name: "openai:chat-completions",
    models: ["vllm-qwen3.6-27b-stream"],
    serviceType: "registry",
  },
];

test("catalogForServiceTypes dual returns union across legacy and registry", () => {
  const dualCatalog = catalogForServiceTypes(sampleCatalog, ["legacy", "registry"]);
  assert.equal(dualCatalog.length, 3);

  const speech = dualCatalog.find((entry) => entry.id === "openai:audio-speech");
  assert.ok(speech);
  assert.deepEqual(speech.models, ["default", "kokoro"]);
  assert.equal(speech.serviceType, "registry");

  assert.ok(dualCatalog.some((entry) => entry.id === "streamdiffusion-sdxl"));
  assert.ok(dualCatalog.some((entry) => entry.id === "openai:chat-completions"));
});

test("catalogForServiceTypes single-scope returns only selected service type", () => {
  const legacyOnly = catalogForServiceTypes(sampleCatalog, ["legacy"]);
  assert.equal(legacyOnly.length, 2);
  assert.ok(legacyOnly.every((entry) => entry.serviceType === "legacy"));
});
