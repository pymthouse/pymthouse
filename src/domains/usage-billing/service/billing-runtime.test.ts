import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import protobuf from "protobufjs";

import {
  buildConstraintHash,
  buildSignedTicketConstraintHash,
  computeUsdMicrosFromWei,
  resolveGatewayAttribution,
  resolvePaymentPipelineModelConstraint,
  resolveRequestPipelineModelConstraint,
  resolveUpcharge,
  weiToEthString,
} from "./billing-runtime";

test("resolveRequestPipelineModelConstraint returns canonical fields", () => {
  const result = resolveRequestPipelineModelConstraint({
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
  });
  assert.deepEqual(result, { pipeline: "text-to-image", modelId: "stabilityai/sdxl" });
});

test("resolveRequestPipelineModelConstraint accepts legacy Model alias", () => {
  const result = resolveRequestPipelineModelConstraint({
    pipeline: "text-to-image",
    model: "some/model",
  });
  assert.ok(result);
  assert.equal(result!.modelId, "some/model");
});

test("resolveRequestPipelineModelConstraint returns null when pipeline is missing", () => {
  assert.equal(resolveRequestPipelineModelConstraint({ modelId: "some/model" }), null);
});

test("resolveRequestPipelineModelConstraint returns null when modelId is missing", () => {
  assert.equal(resolveRequestPipelineModelConstraint({ pipeline: "text-to-image" }), null);
});

test("resolveRequestPipelineModelConstraint returns null for empty body", () => {
  assert.equal(resolveRequestPipelineModelConstraint({}), null);
});

async function lv2vCapabilitiesBase64(modelId: string): Promise<string> {
  const protoPath = path.resolve(process.cwd(), "proto/lp_rpc.proto");
  const root = await protobuf.load(protoPath);
  const Capabilities = root.lookupType("net.Capabilities");
  const payload = {
    capacities: { 35: 1 },
    constraints: {
      PerCapability: {
        35: {
          models: {
            [modelId]: {},
          },
        },
      },
    },
  };
  const err = Capabilities.verify(payload);
  if (err) throw new Error(err);
  const msg = Capabilities.create(payload);
  return Buffer.from(Capabilities.encode(msg).finish()).toString("base64");
}

test("resolvePaymentPipelineModelConstraint reads capabilities base64", async () => {
  const caps = await lv2vCapabilitiesBase64("streamdiffusion-sdxl");
  const result = await resolvePaymentPipelineModelConstraint({ capabilities: caps });
  assert.deepEqual(result, {
    pipeline: "live-video-to-video",
    modelId: "streamdiffusion-sdxl",
  });
});

test("resolvePaymentPipelineModelConstraint prefers explicit pipeline over capabilities", async () => {
  const caps = await lv2vCapabilitiesBase64("streamdiffusion-sdxl");
  const result = await resolvePaymentPipelineModelConstraint({
    capabilities: caps,
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
  });
  assert.deepEqual(result, { pipeline: "text-to-image", modelId: "stabilityai/sdxl" });
});

test("resolvePaymentPipelineModelConstraint returns null for invalid capabilities", async () => {
  const result = await resolvePaymentPipelineModelConstraint({
    capabilities: "not-valid-base64!!!",
  });
  assert.equal(result, null);
});

test("resolveGatewayAttribution reads all three fields", () => {
  const result = resolveGatewayAttribution({
    attributionSource: "pymthouse_gateway",
    gatewayRequestId: "job-123",
    paymentMetadataVersion: "2026-04-usage-attribution-v1",
  });
  assert.equal(result.attributionSource, "pymthouse_gateway");
  assert.equal(result.gatewayRequestId, "job-123");
  assert.equal(result.paymentMetadataVersion, "2026-04-usage-attribution-v1");
});

test("resolveGatewayAttribution defaults attributionSource to direct_api", () => {
  const result = resolveGatewayAttribution({});
  assert.equal(result.attributionSource, "direct_api");
  assert.equal(result.gatewayRequestId, null);
  assert.equal(result.paymentMetadataVersion, null);
});

test("buildSignedTicketConstraintHash matches buildConstraintHash for same tuple", () => {
  const params = {
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
    orchAddress: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    signedPriceWeiPerUnit: "1000000000",
    signedPixelsPerUnit: "1",
  };
  assert.equal(
    buildSignedTicketConstraintHash(params),
    buildConstraintHash({
      pipeline: params.pipeline,
      modelId: params.modelId,
      orchAddress: params.orchAddress,
      priceWeiPerUnit: params.signedPriceWeiPerUnit,
      pixelsPerUnit: params.signedPixelsPerUnit,
    }),
  );
});

test("buildSignedTicketConstraintHash is deterministic", () => {
  const params = {
    pipeline: "p",
    modelId: "m",
    orchAddress: "0xabcd",
    signedPriceWeiPerUnit: "1",
    signedPixelsPerUnit: "1",
  };
  assert.equal(buildSignedTicketConstraintHash(params), buildSignedTicketConstraintHash(params));
});

test("buildConstraintHash is deterministic", () => {
  const params = {
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
    orchAddress: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    priceWeiPerUnit: "1000000000",
    pixelsPerUnit: "1",
  };
  assert.equal(buildConstraintHash(params), buildConstraintHash(params));
});

test("buildConstraintHash differs for different params", () => {
  const base = {
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
    orchAddress: "0xABCDEF",
    priceWeiPerUnit: "1000000000",
    pixelsPerUnit: "1",
  };
  assert.notEqual(buildConstraintHash(base), buildConstraintHash({ ...base, priceWeiPerUnit: "2000000000" }));
});

test("buildConstraintHash normalises orchAddress to lowercase", () => {
  const lower = buildConstraintHash({ pipeline: "p", modelId: "m", orchAddress: "0xabcd", priceWeiPerUnit: "1", pixelsPerUnit: "1" });
  const upper = buildConstraintHash({ pipeline: "p", modelId: "m", orchAddress: "0XABCD", priceWeiPerUnit: "1", pixelsPerUnit: "1" });
  assert.equal(lower, upper);
});

test("computeUsdMicrosFromWei: 1 ETH at $3000 = 3_000_000_000 micros", () => {
  assert.equal(computeUsdMicrosFromWei(10n ** 18n, 3000), 3_000_000_000n);
});

test("computeUsdMicrosFromWei: zero wei returns 0", () => {
  assert.equal(computeUsdMicrosFromWei(0n, 3000), 0n);
});

test("computeUsdMicrosFromWei: negative price returns 0", () => {
  assert.equal(computeUsdMicrosFromWei(10n ** 18n, -1), 0n);
});

test("computeUsdMicrosFromWei: non-finite price returns 0", () => {
  assert.equal(computeUsdMicrosFromWei(10n ** 18n, NaN), 0n);
  assert.equal(computeUsdMicrosFromWei(10n ** 18n, Infinity), 0n);
});

test("computeUsdMicrosFromWei: small wei amount stays integer", () => {
  assert.equal(typeof computeUsdMicrosFromWei(1_000_000n, 3000), "bigint");
});

test("weiToEthString: 0 returns '0'", () => {
  assert.equal(weiToEthString(0n), "0");
});

test("weiToEthString: 1 ETH", () => {
  assert.equal(weiToEthString(10n ** 18n), "1");
});

test("weiToEthString: 1.5 ETH", () => {
  assert.equal(weiToEthString(15n * 10n ** 17n), "1.5");
});

test("weiToEthString: strips trailing zeros", () => {
  const result = weiToEthString(10n ** 18n + 100_000_000n);
  assert.ok(!result.endsWith("0"), `Expected no trailing zeros, got: ${result}`);
});

const basePlan = {
  id: "plan-1",
  clientId: "app-1",
  name: "Test",
  type: "subscription",
  priceAmount: "0",
  priceCurrency: "USD",
  status: "active",
  includedUnits: null,
  overageRateWei: null,
  includedUsdMicros: null,
  generalUpchargePercentBps: 2000,
  payPerUseUpchargePercentBps: 1000,
  billingCycle: "monthly",
  discoveryProfileId: null,
  createdAt: "",
  updatedAt: "",
} as const;

const baseBundle = {
  id: "bundle-1",
  planId: "plan-1",
  clientId: "app-1",
  pipeline: "text-to-image",
  modelId: "stabilityai/sdxl",
  slaTargetScore: null,
  slaTargetP95Ms: null,
  maxPricePerUnit: null,
  upchargePercentBps: 5000,
  createdAt: "",
} as const;

test("resolveUpcharge prefers exact bundle override", () => {
  const result = resolveUpcharge({
    plan: basePlan,
    bundles: [baseBundle],
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
  });
  assert.deepEqual(result, { bps: 5000, source: "pipeline_model" });
});

test("resolveUpcharge falls back to plan general upcharge", () => {
  const result = resolveUpcharge({
    plan: basePlan,
    bundles: [],
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
  });
  assert.deepEqual(result, { bps: 2000, source: "general" });
});

test("resolveUpcharge falls back to pay_per_use", () => {
  const result = resolveUpcharge({
    plan: { ...basePlan, generalUpchargePercentBps: null },
    bundles: [],
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
  });
  assert.deepEqual(result, { bps: 1000, source: "pay_per_use" });
});

test("resolveUpcharge returns unpriced when no pricing rules apply", () => {
  const result = resolveUpcharge({
    plan: {
      ...basePlan,
      generalUpchargePercentBps: null,
      payPerUseUpchargePercentBps: null,
    },
    bundles: [],
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
  });
  assert.deepEqual(result, { bps: 0, source: "unpriced" });
});
