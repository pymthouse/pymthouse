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
  weiToEthString,
} from "./billing-runtime";

// ─── resolveRequestPipelineModelConstraint ────────────────────────────────────

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
  const result = resolveRequestPipelineModelConstraint({ modelId: "some/model" });
  assert.equal(result, null);
});

test("resolveRequestPipelineModelConstraint returns null when modelId is missing", () => {
  const result = resolveRequestPipelineModelConstraint({ pipeline: "text-to-image" });
  assert.equal(result, null);
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
  const r = await resolvePaymentPipelineModelConstraint({ capabilities: caps });
  assert.deepEqual(r, {
    pipeline: "live-video-to-video",
    modelId: "streamdiffusion-sdxl",
  });
});

test("resolvePaymentPipelineModelConstraint prefers explicit pipeline over capabilities", async () => {
  const caps = await lv2vCapabilitiesBase64("streamdiffusion-sdxl");
  const r = await resolvePaymentPipelineModelConstraint({
    capabilities: caps,
    pipeline: "text-to-image",
    modelId: "stabilityai/sdxl",
  });
  assert.deepEqual(r, { pipeline: "text-to-image", modelId: "stabilityai/sdxl" });
});

test("resolvePaymentPipelineModelConstraint returns null for invalid capabilities", async () => {
  const r = await resolvePaymentPipelineModelConstraint({
    capabilities: "not-valid-base64!!!",
  });
  assert.equal(r, null);
});

// ─── resolveGatewayAttribution ───────────────────────────────────────────────

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

// ─── buildSignedTicketConstraintHash ──────────────────────────────────────────

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

// ─── buildConstraintHash ──────────────────────────────────────────────────────

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
  const modified = { ...base, priceWeiPerUnit: "2000000000" };
  assert.notEqual(buildConstraintHash(base), buildConstraintHash(modified));
});

test("buildConstraintHash normalises orchAddress to lowercase", () => {
  const lower = buildConstraintHash({ pipeline: "p", modelId: "m", orchAddress: "0xabcd", priceWeiPerUnit: "1", pixelsPerUnit: "1" });
  const upper = buildConstraintHash({ pipeline: "p", modelId: "m", orchAddress: "0XABCD", priceWeiPerUnit: "1", pixelsPerUnit: "1" });
  assert.equal(lower, upper);
});

// ─── computeUsdMicrosFromWei ──────────────────────────────────────────────────

test("computeUsdMicrosFromWei: 1 ETH at $3000 = 3_000_000_000 micros", () => {
  const oneEthWei = 10n ** 18n;
  assert.equal(computeUsdMicrosFromWei(oneEthWei, 3000), 3_000_000_000n);
});

test("computeUsdMicrosFromWei: zero wei returns 0", () => {
  assert.equal(computeUsdMicrosFromWei(0n, 3000), 0n);
});

test("computeUsdMicrosFromWei: negative price returns 0", () => {
  assert.equal(computeUsdMicrosFromWei(10n ** 18n, -1), 0n);
});

test("computeUsdMicrosFromWei: non-finite price returns 0", () => {
  assert.equal(computeUsdMicrosFromWei(10n ** 18n, Number.NaN), 0n);
  assert.equal(computeUsdMicrosFromWei(10n ** 18n, Infinity), 0n);
});

test("computeUsdMicrosFromWei: small wei amount stays integer", () => {
  const smallWei = 1_000_000n; // 0.000_000_000_001 ETH
  const result = computeUsdMicrosFromWei(smallWei, 3000);
  assert.ok(typeof result === "bigint");
});

// ─── weiToEthString ───────────────────────────────────────────────────────────

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
