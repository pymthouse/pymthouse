import assert from "node:assert/strict";
import { test } from "node:test";

import {
  catalogFromDiscoveryRaw,
  filterPricingRows,
  splitCapability,
  type PricingRow,
} from "./network-catalog";

const rows: PricingRow[] = [
  {
    orchAddress: "0xaaa",
    pipeline: "text-to-image",
    model: "sdxl",
    priceWeiPerUnit: "1000",
    pixelsPerUnit: "1",
  },
  {
    orchAddress: "0xbbb",
    pipeline: "text-to-image",
    model: "sdxl",
    priceWeiPerUnit: "900",
    pixelsPerUnit: "1",
  },
  {
    orchAddress: "0xaaa",
    pipeline: "image-to-image",
    model: "controlnet",
    priceWeiPerUnit: "500",
    pixelsPerUnit: "2",
  },
];

test("splitCapability: pipeline/model", () => {
  assert.deepEqual(splitCapability("transcode/ffmpeg"), {
    pipeline: "transcode",
    model: "ffmpeg",
  });
});

test("splitCapability: bare capability uses same id for pipeline and model", () => {
  assert.deepEqual(splitCapability("streamdiffusion-sdxl"), {
    pipeline: "streamdiffusion-sdxl",
    model: "streamdiffusion-sdxl",
  });
});

test("catalogFromDiscoveryRaw aggregates capabilities across orchestrators", () => {
  const catalog = catalogFromDiscoveryRaw([
    {
      address: "https://a.example",
      capabilities: ["streamdiffusion-sdxl", "transcode/ffmpeg"],
    },
    {
      address: "https://b.example",
      capabilities: ["streamdiffusion-sdxl", "streamdiffusion-sdxl-v2v"],
    },
    {
      address: "https://c.example",
      capabilities: ["livepeer-example/hello-world"],
    },
  ]);

  assert.deepEqual(catalog, [
    {
      id: "livepeer-example",
      name: "livepeer-example",
      models: ["hello-world"],
    },
    {
      id: "streamdiffusion-sdxl",
      name: "streamdiffusion-sdxl",
      models: ["streamdiffusion-sdxl"],
    },
    {
      id: "streamdiffusion-sdxl-v2v",
      name: "streamdiffusion-sdxl-v2v",
      models: ["streamdiffusion-sdxl-v2v"],
    },
    {
      id: "transcode",
      name: "transcode",
      models: ["ffmpeg"],
    },
  ]);
});

test("catalogFromDiscoveryRaw rejects non-array", () => {
  assert.throws(() => catalogFromDiscoveryRaw({}), /not an array/);
});

test("filterPricingRows: returns rows matching pipeline and model", () => {
  const result = filterPricingRows(rows, "text-to-image", "sdxl");
  assert.equal(result.length, 2);
  assert.ok(
    result.every((r) => r.pipeline === "text-to-image" && r.model === "sdxl"),
  );
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
