import protobuf from "protobufjs";
import path from "path";

let orchestratorInfoType: protobuf.Type | null = null;
let capabilitiesType: protobuf.Type | null = null;

async function loadOrchestratorInfoType(): Promise<protobuf.Type> {
  if (orchestratorInfoType) return orchestratorInfoType;

  const protoPath = path.resolve(process.cwd(), "proto/lp_rpc.proto");
  const root = await protobuf.load(protoPath);
  orchestratorInfoType = root.lookupType("net.OrchestratorInfo");
  return orchestratorInfoType;
}

async function loadCapabilitiesType(): Promise<protobuf.Type> {
  if (capabilitiesType) return capabilitiesType;

  const protoPath = path.resolve(process.cwd(), "proto/lp_rpc.proto");
  const root = await protobuf.load(protoPath);
  capabilitiesType = root.lookupType("net.Capabilities");
  return capabilitiesType;
}

/**
 * Map numeric capability id (livepeer `CapabilityId`) to pipeline slug used in
 * discovery and NaaP pricing (matches python-gateway `capability_pipeline_id`).
 */
export function capabilityIdToPipelineId(capId: number): string | null {
  const names: Record<number, string> = {
    [-2]: "INVALID",
    [-1]: "UNUSED",
    0: "H264",
    1: "MPEGTS",
    2: "MP4",
    3: "FRACTIONAL_FRAMERATES",
    4: "STORAGE_DIRECT",
    5: "STORAGE_S3",
    6: "STORAGE_GCS",
    7: "H264_BASELINE_PROFILE",
    8: "H264_MAIN_PROFILE",
    9: "H264_HIGH_PROFILE",
    10: "H264_CONSTRAINED_CONTAINED_HIGH_PROFILE",
    11: "GOP",
    12: "AUTH_TOKEN",
    14: "MPEG7_SIGNATURE",
    15: "HEVC_DECODE",
    16: "HEVC_ENCODE",
    17: "VP8_DECODE",
    18: "VP9_DECODE",
    19: "VP8_ENCODE",
    20: "VP9_ENCODE",
    21: "H264_DECODE_YUV444_8BIT",
    22: "H264_DECODE_YUV422_8BIT",
    23: "H264_DECODE_YUV444_10BIT",
    24: "H264_DECODE_YUV422_10BIT",
    25: "H264_DECODE_YUV420_10BIT",
    26: "SEGMENT_SLICING",
    27: "TEXT_TO_IMAGE",
    28: "IMAGE_TO_IMAGE",
    29: "IMAGE_TO_VIDEO",
    30: "UPSCALE",
    31: "AUDIO_TO_TEXT",
    32: "SEGMENT_ANYTHING_2",
    33: "LLM",
    34: "IMAGE_TO_TEXT",
    35: "LIVE_VIDEO_TO_VIDEO",
    36: "TEXT_TO_SPEECH",
    37: "BYOC",
  };
  const enumName = names[capId];
  if (!enumName) return null;
  return enumName.toLowerCase().replace(/_/g, "-");
}

export interface PriceInfo {
  pricePerUnit: number;
  pixelsPerUnit: number;
  capability?: number;
  constraint?: string;
}

export interface DecodedOrchestratorInfo {
  transcoder?: string;
  address?: Uint8Array;
  priceInfo?: PriceInfo;
  capabilitiesPrices?: PriceInfo[];
}

/**
 * Decode an OrchestratorInfo protobuf from base64-encoded bytes.
 * The gateway sends this as a base64 string in the JSON request body.
 */
export async function decodeOrchestratorInfo(
  orchestratorBytes: Buffer | Uint8Array | string
): Promise<DecodedOrchestratorInfo> {
  const type = await loadOrchestratorInfoType();

  let buf: Uint8Array;
  if (typeof orchestratorBytes === "string") {
    buf = Buffer.from(orchestratorBytes, "base64");
  } else {
    buf = orchestratorBytes;
  }

  const message = type.decode(buf);
  const obj = type.toObject(message, {
    longs: Number,
    bytes: Buffer,
    defaults: true,
  });

  return {
    transcoder: obj.transcoder || undefined,
    address: obj.address || undefined,
    priceInfo: obj.priceInfo
      ? {
          pricePerUnit: obj.priceInfo.pricePerUnit || 0,
          pixelsPerUnit: obj.priceInfo.pixelsPerUnit || 1,
          capability: obj.priceInfo.capability,
          constraint: obj.priceInfo.constraint,
        }
      : undefined,
    capabilitiesPrices: obj.capabilitiesPrices?.map(
      (p: Record<string, unknown>) => ({
        pricePerUnit: (p.pricePerUnit as number) || 0,
        pixelsPerUnit: (p.pixelsPerUnit as number) || 1,
        capability: p.capability as number | undefined,
        constraint: p.constraint as string | undefined,
      })
    ),
  };
}

export interface PipelineModelFromCapabilities {
  pipeline: string;
  modelId: string;
}

/**
 * Decode `net.Capabilities` from base64 (same wire format python-gateway sends).
 */
export async function decodeCapabilities(
  capabilitiesBytes: Buffer | Uint8Array | string,
): Promise<Record<string, unknown>> {
  const type = await loadCapabilitiesType();

  let buf: Uint8Array;
  if (typeof capabilitiesBytes === "string") {
    buf = Buffer.from(capabilitiesBytes, "base64");
  } else {
    buf = capabilitiesBytes;
  }

  const message = type.decode(buf);
  return type.toObject(message, {
    longs: Number,
    bytes: Buffer,
    defaults: true,
  }) as Record<string, unknown>;
}

/**
 * Extract the first constrained pipeline/model from decoded Capabilities
 * (`constraints.PerCapability[*].models`), deterministic order matching
 * python-gateway `capabilities_to_query`.
 */
export function extractPipelineModelFromCapabilitiesObject(
  obj: Record<string, unknown>,
): PipelineModelFromCapabilities | null {
  const constraints = obj.constraints as Record<string, unknown> | undefined;
  if (!constraints || typeof constraints !== "object") return null;

  const perRaw =
    constraints.PerCapability ??
    (constraints as { perCapability?: unknown }).perCapability;
  if (!perRaw || typeof perRaw !== "object") return null;

  const per = perRaw as Record<string, unknown>;
  const capIds = Object.keys(per)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  for (const capId of capIds) {
    const pipeline = capabilityIdToPipelineId(capId);
    if (!pipeline) continue;

    const capBlock = per[String(capId)] as Record<string, unknown> | undefined;
    if (!capBlock || typeof capBlock !== "object") continue;

    const models = capBlock.models as Record<string, unknown> | undefined;
    if (!models || typeof models !== "object") continue;

    const modelKeys = Object.keys(models)
      .filter((m) => typeof m === "string" && m.trim())
      .sort();
    if (modelKeys.length === 0) continue;

    return { pipeline, modelId: modelKeys[0]! };
  }

  return null;
}

export async function extractPipelineModelFromCapabilitiesBase64(
  base64: string,
): Promise<PipelineModelFromCapabilities | null> {
  try {
    const obj = await decodeCapabilities(base64.trim());
    return extractPipelineModelFromCapabilitiesObject(obj);
  } catch {
    return null;
  }
}

/**
 * Calculate fee in wei from pixel count and price info.
 *
 * feeWei = pixels * pricePerUnit / pixelsPerUnit
 */
export function calculateFeeWei(
  pixels: bigint,
  pricePerUnit: bigint,
  pixelsPerUnit: bigint
): bigint {
  if (pixelsPerUnit === 0n) return 0n;
  return (pixels * pricePerUnit) / pixelsPerUnit;
}

/**
 * Calculate platform cut from fee.
 *
 * platformCutWei = feeWei * cutPercent / 100
 */
export function calculatePlatformCut(
  feeWei: bigint,
  cutPercent: number
): bigint {
  const cutBasis = BigInt(Math.round(cutPercent * 100));
  return (feeWei * cutBasis) / 10000n;
}

/**
 * For lv2v (live video-to-video) jobs without explicit InPixels,
 * calculate pixels from elapsed time.
 *
 * Default: 1280x720 @ 30fps = 27,648,000 pixels/sec
 */
export function calculateLv2vPixels(secondsElapsed: number): bigint {
  const PIXELS_PER_SEC = 1280 * 720 * 30; // 27,648,000
  return BigInt(Math.floor(PIXELS_PER_SEC * secondsElapsed));
}
