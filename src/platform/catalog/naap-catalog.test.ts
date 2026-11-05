import assert from "node:assert/strict";
import { test } from "node:test";

import { filterPricingRows } from "@/platform/catalog/naap-catalog";
import type { PricingRow } from "@/platform/catalog/naap-catalog";

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
