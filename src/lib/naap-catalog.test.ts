import assert from "node:assert/strict";
import { test } from "node:test";

import {
  catalogFromDiscoveryCapabilities,
  filterCatalogByServiceType,
  filterPricingRows,
} from "./naap-catalog";
import type { PricingRow } from "./naap-catalog";
import {
  catalogServiceTypeForSigningMode,
  catalogServiceTypesForSigningMode,
  SIGNING_MODE_DUAL,
  SIGNING_MODE_LPNM_PAYER_DAEMON,
} from "@/lib/signing-modes";

const rows: PricingRow[] = [
  { orchAddress: "0xaaa", pipeline: "text-to-image", model: "sdxl", priceWeiPerUnit: "1000", pixelsPerUnit: "1" },
  { orchAddress: "0xbbb", pipeline: "text-to-image", model: "sdxl", priceWeiPerUnit: "900", pixelsPerUnit: "1" },
  { orchAddress: "0xaaa", pipeline: "image-to-image", model: "controlnet", priceWeiPerUnit: "500", pixelsPerUnit: "2" },
];

test("filterPricingRows: returns rows matching pipeline and model", () => {
  const result = filterPricingRows(rows, "text-to-image", "sdxl");
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.pipeline === "text-to-image" && r.model === "sdxl"));
});

test("filterPricingRows: further filters by orchAddress when provided", () => {
  const result = filterPricingRows(rows, "text-to-image", "sdxl", "0xaaa");
  assert.equal(result.length, 1);
  assert.equal(result[0].orchAddress, "0xaaa");
});

test("filterPricingRows: orchAddress match is case-insensitive", () => {
  const result = filterPricingRows(rows, "text-to-image", "sdxl", "0xAAA");
  assert.equal(result.length, 1);
  assert.equal(result[0].orchAddress, "0xaaa");
});

test("filterPricingRows: returns empty when no pipeline match", () => {
  const result = filterPricingRows(rows, "audio-generation", "model");
  assert.equal(result.length, 0);
});

test("filterPricingRows: returns empty for empty rows", () => {
  const result = filterPricingRows([], "text-to-image", "sdxl");
  assert.equal(result.length, 0);
});

test("filterPricingRows: correct model filtering", () => {
  const result = filterPricingRows(rows, "image-to-image", "controlnet");
  assert.equal(result.length, 1);
  assert.equal(result[0].model, "controlnet");
});

test("catalogFromDiscoveryCapabilities: maps registry capability and offerings", () => {
  const catalog = catalogFromDiscoveryCapabilities({
    capabilities: ["openai:audio-speech"],
    entries: [
      {
        serviceType: "registry",
        capability: "openai:audio-speech",
        offeringIds: ["kokoro"],
      },
    ],
  });
  assert.deepEqual(catalog, [
    {
      id: "openai:audio-speech",
      name: "openai:audio-speech",
      models: ["kokoro"],
      serviceType: "registry",
    },
  ]);
});

test("catalogFromDiscoveryCapabilities: legacy entries use default offering placeholder", () => {
  const catalog = catalogFromDiscoveryCapabilities({
    entries: [
      { serviceType: "legacy", capability: "streamdiffusion-sdxl" },
      {
        serviceType: "registry",
        capability: "openai:chat-completions",
        offeringIds: ["vllm-qwen3.6-27b-stream", "vllm-qwen3.6-27b-default"],
      },
    ],
  });
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog[0], {
    id: "openai:chat-completions",
    name: "openai:chat-completions",
    models: ["vllm-qwen3.6-27b-default", "vllm-qwen3.6-27b-stream"],
    serviceType: "registry",
  });
  assert.deepEqual(catalog[1], {
    id: "streamdiffusion-sdxl",
    name: "streamdiffusion-sdxl",
    models: ["default"],
    serviceType: "legacy",
  });
});

test("filterCatalogByServiceType keeps only matching serviceType rows", () => {
  const catalog = catalogFromDiscoveryCapabilities({
    entries: [
      { serviceType: "legacy", capability: "streamdiffusion-sdxl" },
      {
        serviceType: "registry",
        capability: "openai:audio-speech",
        offeringIds: ["kokoro"],
      },
    ],
  });
  assert.equal(filterCatalogByServiceType(catalog, "registry").length, 1);
  assert.equal(filterCatalogByServiceType(catalog, "registry")[0]?.id, "openai:audio-speech");
  assert.equal(filterCatalogByServiceType(catalog, "legacy").length, 1);
  assert.equal(
    filterCatalogByServiceType(catalog, "legacy")[0]?.id,
    "streamdiffusion-sdxl",
  );
});

test("catalogServiceTypeForSigningMode maps LPNM to registry", () => {
  assert.equal(
    catalogServiceTypeForSigningMode(SIGNING_MODE_LPNM_PAYER_DAEMON),
    "registry",
  );
  assert.equal(catalogServiceTypeForSigningMode("legacy_remote_signer"), "legacy");
});

test("catalogServiceTypesForSigningMode dual returns both scopes", () => {
  assert.deepEqual(catalogServiceTypesForSigningMode(SIGNING_MODE_DUAL), [
    "legacy",
    "registry",
  ]);
});

